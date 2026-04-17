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
import { loadSystemPrompt, loadLintPrompt, buildPromptBlocks } from "./prompt.js";
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
  sendExtractions(extractions: Extraction[], notesContext?: string): Promise<string>;
  sendScreenshots(screenshots: Screenshot[]): Promise<string>;
  sendLint(file: string): Promise<string>;
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
            usage[currentSessionKind].cost = u.cost.amount;
            usage[currentSessionKind].currency = u.cost.currency ?? "USD";
          }
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

  function trackPromptUsage(kind: "fast" | "smart", response: any) {
    const u = response?.usage;
    if (u) {
      usage[kind].inputTokens += u.inputTokens ?? 0;
      usage[kind].outputTokens += u.outputTokens ?? 0;
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
      trackPromptUsage("fast", response);

      const result = streamBuffer.join("").trim();
      if (result.includes("NO CHANGES") || result.includes("NO REAL CHANGES")) {
        return "";
      }
      lastExtraction = result;
      return result;
    },

    async sendExtractions(extractions: Extraction[], notesContext?: string): Promise<string> {
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
        body += "Apple Notes are a primary source of the user's thoughts, plans, and context. " +
          "Integrate relevant information into the wiki — update person pages, project pages, " +
          "or create new ones as appropriate. Note titles often hint at the topic.\n\n";
      }

      body += "Update the wiki based on these observations. Brief summary of what you observed and changed.";

      streamBuffer.length = 0;

      const extractionsResp = await client.prompt({
        sessionId,
        prompt: [
          { type: "text", text: systemPrompt + "\n\n---\n\n" + body },
        ] as ContentBlock[],
      });
      trackPromptUsage("smart", extractionsResp);

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
      trackPromptUsage("smart", screenshotsResp);

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
      trackPromptUsage("smart", lintResp);

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
