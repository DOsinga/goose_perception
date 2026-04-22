import { spawn, execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  Stream,
  ContentBlock,
} from "@agentclientprotocol/sdk";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { GooseClient } from "@aaif/goose-sdk";
import type { Screenshot } from "./screenshot.js";
import { loadSystemPrompt, loadLintPrompt, loadTodoReviewPrompt, loadReflectPrompt, buildPromptBlocks } from "./prompt.js";
import { getWikiSummary, getRecentLog } from "./wiki.js";

export interface AgentConfig {
  rootDir: string;
  wikiDir: string;
  serverUrl?: string;
  fastProvider?: string;
  fastModel?: string;
  smartProvider?: string;
  smartModel?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface Extraction {
  filename: string;
  timestamp: Date;
  text: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;       // cumulative USD
  currency: string;
}

export interface AgentHandle {
  extractScreenshot(screenshot: Screenshot): Promise<string>;
  sendExtractions(extractions: Extraction[], notesContext?: string, voiceContext?: string): Promise<string>;
  sendScreenshots(screenshots: Screenshot[]): Promise<string>;
  sendLint(file: string): Promise<string>;
  sendTodoReview(): Promise<string>;
  sendReflection(): Promise<string>;
  getUsage(): { fast: TokenUsage; smart: TokenUsage; total: TokenUsage };
  listProviders(): Promise<ProviderInfo[]>;
  listModels(provider: string): Promise<{ models: ModelInfo[]; current: string }>;
  shutdown(): void;
}

/**
 * Connect to a goose agent and return a handle for sending screenshot batches.
 * Each batch creates a fresh session so images don't accumulate in history.
 * The wiki itself provides continuity between batches.
 */
export async function connectAgent(config: AgentConfig): Promise<AgentHandle> {
  let serverProcess: ReturnType<typeof spawn> | null = null;
  let serverConnection: Stream | string;

  if (config.serverUrl) {
    serverConnection = config.serverUrl;
  } else {
    const binary = findServerBinary();
    if (!binary) {
      throw new Error(
        "No goose binary found. Use --server <url> or install the native package.",
      );
    }

    serverProcess = spawn(binary, ["acp"], {
      stdio: ["pipe", "pipe", "ignore"],
      detached: false,
    });

    serverProcess.on("error", (err) => {
      throw new Error(`Failed to start goose acp: ${err.message}`);
    });

    const output = Writable.toWeb(serverProcess.stdin!) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(serverProcess.stdout!) as ReadableStream<Uint8Array>;
    serverConnection = ndJsonStream(output, input);
  }

  const streamBuffer: string[] = [];

  // Token usage tracking
  const usage = {
    fast: { inputTokens: 0, outputTokens: 0, cost: 0, currency: "USD" },
    smart: { inputTokens: 0, outputTokens: 0, cost: 0, currency: "USD" },
  };
  let currentSessionKind: "fast" | "smart" = "fast";

  const client = new GooseClient(
    () => ({
      sessionUpdate: async (params: SessionNotification) => {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            streamBuffer.push(update.content.text);
            process.stdout.write(update.content.text);
          }
        } else if (update.sessionUpdate === "tool_call") {
          const title = update.title ?? "tool";
          const status = update.status ?? "pending";
          console.log(`  🔧 ${title} [${status}]`);
        } else if (update.sessionUpdate === "tool_call_update") {
          if (update.status) {
            console.log(`  🔧 ${update.title ?? "tool"} [${update.status}]`);
          }
        } else if (update.sessionUpdate === "usage_update") {
          const u = update as any;
          if (u.cost?.amount != null) {
            usage[currentSessionKind].cost += u.cost.amount;
            usage[currentSessionKind].currency = u.cost.currency ?? "USD";
          }
          // usage_update events are informational only — cost already tracked above
        }
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const allowOption = params.options.find((o) => o.kind === "allow_once");
        if (allowOption) {
          return {
            outcome: { outcome: "selected", optionId: allowOption.optionId },
          };
        }
        return { outcome: { outcome: "cancelled" } };
      },
    }),
    serverConnection,
  );

  await client.initialize({
    protocolVersion: 0,
    clientInfo: { name: "autowiki", version: "0.1.0" },
    clientCapabilities: {},
  });

  const EXTRACT_PROMPT =
    "Transcribe all visible text on this screen. Group it by app or window, " +
    "and attribute messages to the person who sent them. Include:\n" +
    "- App/window name and any URL or file path visible\n" +
    "- All readable text: messages, code, documents, notifications\n" +
    "- For chat apps: who said what\n" +
    "- Any error messages, toasts, or popups\n" +
    "Skip UI chrome (menus, buttons) unless they convey information.\n\n" +
    "If the screen is essentially the same as your previous transcription, " +
    "reply with exactly: NO CHANGES";

  let lastExtraction = "";

  // Rough token estimation: ~4 chars per token for English text
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  function trackPromptUsage(kind: "fast" | "smart", response: any, promptText?: string) {
    const u = response?.usage;
    if (u && (u.inputTokens || u.outputTokens)) {
      usage[kind].inputTokens += u.inputTokens ?? 0;
      usage[kind].outputTokens += u.outputTokens ?? 0;
    } else {
      // Goose didn't report usage — estimate from text sizes
      const inputEst = promptText ? estimateTokens(promptText) : 0;
      // For fast model (extraction), image adds ~1500 tokens
      const imageTokens = kind === "fast" ? 1500 : 0;
      usage[kind].inputTokens += inputEst + imageTokens;
      // Estimate output from streamBuffer
      const outputEst = estimateTokens(streamBuffer.join(""));
      usage[kind].outputTokens += outputEst;
    }

    // Update cost estimates based on known model pricing
    // GPT-4o-mini: $0.15/M in, $0.60/M out
    // Claude Opus: $15/M in, $75/M out
    if (kind === "fast") {
      usage.fast.cost = (usage.fast.inputTokens * 0.15 + usage.fast.outputTokens * 0.60) / 1_000_000;
    } else {
      usage.smart.cost = (usage.smart.inputTokens * 15 + usage.smart.outputTokens * 75) / 1_000_000;
    }
  }

  async function createSession(kind: "fast" | "smart"): Promise<string> {
    currentSessionKind = kind;
    const provider = kind === "fast" ? config.fastProvider : config.smartProvider;
    const model = kind === "fast" ? config.fastModel : config.smartModel;

    console.log(`  🔌 Creating ${kind} session: ${provider ?? "default"}/${model ?? "default"}`);

    const session = await client.newSession({
      cwd: config.wikiDir,
      mcpServers: [],
      ...(provider ? { _meta: { provider } } : {}),
    });

    if (provider && model) {
      await client.goose.GooseSessionProviderUpdate({
        sessionId: session.sessionId,
        provider,
        model,
      });
    }

    return session.sessionId;
  }

  return {
    async extractScreenshot(screenshot: Screenshot): Promise<string> {
      const sessionId = await createSession("fast");

      streamBuffer.length = 0;

      const prompt = lastExtraction
        ? `${EXTRACT_PROMPT}\n\nYour previous description was:\n${lastExtraction}`
        : EXTRACT_PROMPT;

      const response = await client.prompt({
        sessionId,
        prompt: [
          { type: "text", text: prompt },
          { type: "image", data: screenshot.base64, mimeType: screenshot.mimeType },
        ] as ContentBlock[],
      });
      trackPromptUsage("fast", response, prompt);

      const result = streamBuffer.join("").trim();
      if (result.includes("NO CHANGES") || result.includes("NO REAL CHANGES")) {
        return "";
      }
      lastExtraction = result;
      return result;
    },

    async sendExtractions(extractions: Extraction[], notesContext?: string, voiceContext?: string): Promise<string> {
      const sessionId = await createSession("smart");

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const recentLog = await getRecentLog(config.wikiDir);
      const systemPrompt = await loadSystemPrompt(config.rootDir, config.wikiDir, wikiSummary, recentLog);

      let body = "";

      if (extractions.length > 0) {
        body += `${extractions.length} screen observation(s) to process:\n\n`;
        for (const ext of extractions) {
          body += `--- [${ext.timestamp.toLocaleTimeString()}] ---\n${ext.text}\n\n`;
        }
      }

      if (notesContext) {
        body += "\n" + notesContext + "\n";
        body += "These notes are one additional signal alongside the screenshots. " +
          "Integrate relevant new information into the wiki if it adds context " +
          "not already captured from screen observations.\n\n";
      }

      if (voiceContext) {
        body += "\n" + voiceContext + "\n";
        body += "These are transcripts of what the user said aloud (meetings, thinking out loud, voice notes). " +
          "Capture decisions, commitments (→ todos.md), action items, and context. " +
          "Attribute statements to the user unless another speaker is identifiable. " +
          "Voice transcripts are noisy — extract the signal, ignore filler words and transcription errors.\n\n";
      }

      body += "Update the wiki based on these observations. Brief summary of what you observed and changed.\n\n";
      body += "Also: read todos.md. If you see evidence an open todo was completed, check it off. " +
        "NEVER un-check or re-open done items (- [x]). Don't rewrite or reorder existing items.";

      streamBuffer.length = 0;

      const fullPrompt = systemPrompt + "\n\n---\n\n" + body;
      const extractionsResp = await client.prompt({
        sessionId,
        prompt: [
          { type: "text", text: fullPrompt },
        ] as ContentBlock[],
      });
      trackPromptUsage("smart", extractionsResp, fullPrompt);

      return streamBuffer.join("");
    },

    async sendScreenshots(screenshots: Screenshot[]): Promise<string> {
      const sessionId = await createSession("smart");

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const recentLog = await getRecentLog(config.wikiDir);
      const systemPrompt = await loadSystemPrompt(config.rootDir, config.wikiDir, wikiSummary, recentLog);
      const blocks = buildPromptBlocks(screenshots);
      blocks.unshift({
        type: "text",
        text: systemPrompt + "\n\n---\n\n",
      });

      streamBuffer.length = 0;

      const screenshotsResp = await client.prompt({
        sessionId,
        prompt: blocks as ContentBlock[],
      });
      const screenshotPromptText = blocks.filter(b => b.type === "text").map(b => (b as any).text).join("\n");
      trackPromptUsage("smart", screenshotsResp, screenshotPromptText);

      return streamBuffer.join("");
    },

    async sendLint(file: string): Promise<string> {
      const sessionId = await createSession("smart");

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const lintPrompt = await loadLintPrompt(config.rootDir, config.wikiDir, wikiSummary, file);

      streamBuffer.length = 0;

      const lintResp = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: lintPrompt } as ContentBlock],
      });
      trackPromptUsage("smart", lintResp, lintPrompt);

      return streamBuffer.join("");
    },

    async sendTodoReview(): Promise<string> {
      const sessionId = await createSession("smart");

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const todoPrompt = await loadTodoReviewPrompt(config.rootDir, config.wikiDir, wikiSummary);

      streamBuffer.length = 0;

      const todoResp = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: todoPrompt } as ContentBlock],
      });
      trackPromptUsage("smart", todoResp, todoPrompt);

      return streamBuffer.join("");
    },

    async sendReflection(): Promise<string> {
      const sessionId = await createSession("smart");

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const reflectPrompt = await loadReflectPrompt(config.rootDir, config.wikiDir, wikiSummary);

      streamBuffer.length = 0;

      const reflectResp = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: reflectPrompt } as ContentBlock],
      });
      trackPromptUsage("smart", reflectResp, reflectPrompt);

      return streamBuffer.join("");
    },

    getUsage() {
      return {
        fast: { ...usage.fast },
        smart: { ...usage.smart },
        total: {
          inputTokens: usage.fast.inputTokens + usage.smart.inputTokens,
          outputTokens: usage.fast.outputTokens + usage.smart.outputTokens,
          cost: usage.fast.cost + usage.smart.cost,
          currency: usage.smart.currency || usage.fast.currency || "USD",
        },
      };
    },

    async listProviders(): Promise<ProviderInfo[]> {
      try {
        const result = await client.goose.GooseProvidersDetails({});
        return result.providers
          .filter((p) => p.isConfigured)
          .map((p) => ({
            id: p.name,
            label: p.displayName || p.name,
          }));
      } catch {
        // Older goose without GooseProvidersDetails — fall back to list + hardcoded filter
        const result = await client.goose.GooseProvidersList({});
        const known = new Map([
          ["databricks", "Databricks"],
          ["anthropic", "Anthropic"],
          ["openai", "OpenAI"],
          ["local", "Local Inference"],
        ]);
        return result.providers
          .filter((p: { id: string }) => known.has(p.id))
          .map((p: { id: string; label: string }) => ({
            id: p.id,
            label: known.get(p.id) ?? p.label,
          }));
      }
    },

    async listModels(provider: string): Promise<{ models: ModelInfo[]; current: string }> {
      try {
        const result = await client.goose.GooseProvidersModels({ providerName: provider });
        return {
          models: result.models.map((id) => ({ id, name: id })),
          current: result.models[0] ?? "",
        };
      } catch {
        // Older goose — create a throwaway session to get model list
        const session = await client.newSession({
          cwd: config.wikiDir,
          mcpServers: [],
          _meta: { provider },
        });
        const models: ModelInfo[] = [];
        let current = "";
        if (session.models) {
          current = session.models.currentModelId ?? "";
          for (const m of session.models.availableModels ?? []) {
            models.push({ id: m.modelId, name: m.name || m.modelId });
          }
        }
        return { models, current };
      }
    },

    shutdown() {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill();
      }
    },
  };
}

function findServerBinary(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, "..", "server-binary.json"),
    join(__dirname, "server-binary.json"),
  ];
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(readFileSync(candidate, "utf-8"));
      return data.binaryPath ?? null;
    } catch {
      // not found here, try next
    }
  }

  // Check well-known install locations before PATH (PATH may have stale versions)
  const wellKnown = [
    "/Users/douwe/proj/goose/target/debug/goose",
    "/opt/homebrew/bin/goose",
    "/usr/local/bin/goose",
  ];
  for (const bin of wellKnown) {
    try {
      execFileSync(bin, ["--version"], { encoding: "utf-8" });
      return bin;
    } catch {
      // not here
    }
  }

  try {
    const found = execFileSync("which", ["goose"], { encoding: "utf-8" }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }

  return null;
}
