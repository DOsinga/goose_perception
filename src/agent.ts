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
import { GooseClient } from "@aaif/goose-acp";
import type { Screenshot } from "./screenshot.js";
import { loadSystemPrompt, loadLintPrompt, buildPromptBlocks } from "./prompt.js";
import { getWikiSummary } from "./wiki.js";

export interface AgentConfig {
  rootDir: string;
  wikiDir: string;
  serverUrl?: string;
}

export interface AgentHandle {
  sendScreenshots(screenshots: Screenshot[]): Promise<string>;
  sendLint(file: string): Promise<string>;
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

  return {
    async sendScreenshots(screenshots: Screenshot[]): Promise<string> {
      const session = await client.newSession({
        cwd: config.wikiDir,
        mcpServers: [],
      });

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const systemPrompt = await loadSystemPrompt(config.rootDir, config.wikiDir, wikiSummary);
      const blocks = buildPromptBlocks(screenshots);
      blocks.unshift({
        type: "text",
        text: systemPrompt + "\n\n---\n\n",
      });

      streamBuffer.length = 0;

      await client.prompt({
        sessionId: session.sessionId,
        prompt: blocks as ContentBlock[],
      });

      return streamBuffer.join("");
    },

    async sendLint(file: string): Promise<string> {
      const session = await client.newSession({
        cwd: config.wikiDir,
        mcpServers: [],
      });

      const wikiSummary = await getWikiSummary(config.wikiDir);
      const lintPrompt = await loadLintPrompt(config.rootDir, config.wikiDir, wikiSummary, file);

      streamBuffer.length = 0;

      await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: lintPrompt } as ContentBlock],
      });

      return streamBuffer.join("");
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

  try {
    const found = execFileSync("which", ["goose"], { encoding: "utf-8" }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }

  return null;
}
