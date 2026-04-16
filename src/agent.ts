import { spawn, execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import {
  loadSystemPrompt,
  loadLintPrompt,
  buildPromptBlocks,
} from "./prompt.js";
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

    const gooseEnv = prepareGooseEnvironment();

    serverProcess = spawn(binary, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GOOSE_PATH_ROOT: gooseEnv },
      detached: false,
    });

    // Log goose stderr for debugging
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    serverProcess.on("error", (err) => {
      throw new Error(`Failed to start goose acp: ${err.message}`);
    });

    const output = Writable.toWeb(
      serverProcess.stdin!,
    ) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(
      serverProcess.stdout!,
    ) as ReadableStream<Uint8Array>;
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
      const systemPrompt = await loadSystemPrompt(
        config.rootDir,
        config.wikiDir,
        wikiSummary,
      );
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
      const lintPrompt = await loadLintPrompt(
        config.rootDir,
        config.wikiDir,
        wikiSummary,
        file,
      );

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

/**
 * Create an isolated GOOSE_PATH_ROOT so only the extensions we specify load.
 * Symlinks the real data dir so downloaded models are still accessible.
 * Returns the path to use as GOOSE_PATH_ROOT.
 */
function prepareGooseEnvironment(): string {
  const root = join(homedir(), "perception", ".goose");
  const configDir = join(root, "config");
  const dataDir = join(root, "data");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });

  // Config with only computercontroller enabled — list all known extensions so goose
  // doesn't backfill defaults. Provider and model are set here too so no env vars needed.
  writeFileSync(join(configDir, "config.yaml"), `GOOSE_PROVIDER: local
GOOSE_MODEL: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M"
extensions:
  developer:
    enabled: false
    type: platform
    name: developer
    description: Write and edit files, and execute shell commands
    display_name: Developer
    bundled: true
    available_tools: []
  computercontroller:
    enabled: true
    type: builtin
    name: computercontroller
    description: General computer control tools that don't require you to be a developer or engineer.
    display_name: Computer Controller
    timeout: 300
    bundled: true
    available_tools: []
  summon:
    enabled: false
    type: platform
    name: summon
    description: Load knowledge and delegate tasks to subagents
    display_name: Summon
    bundled: true
    available_tools: []
  analyze:
    enabled: false
    type: platform
    name: analyze
    description: 'Analyze code structure with tree-sitter: directory overviews, file details, symbol call graphs'
    display_name: Analyze
    bundled: true
    available_tools: []
  skills:
    enabled: false
    type: platform
    name: skills
    description: Discover and provide skill instructions from filesystem and builtins
    display_name: Skills
    bundled: true
    available_tools: []
  todo:
    enabled: false
    type: platform
    name: todo
    description: Enable a todo list for goose so it can keep track of what it is doing
    display_name: Todo
    bundled: true
    available_tools: []
  orchestrator:
    enabled: false
    type: platform
    name: orchestrator
    description: 'Manage agent sessions: list, view, start, send messages, interrupt, and stop agents'
    display_name: Orchestrator
    bundled: true
    available_tools: []
  summarize:
    enabled: false
    type: platform
    name: summarize
    description: Load files/directories and get an LLM summary in a single call
    display_name: Summarize
    bundled: true
    available_tools: []
  chatrecall:
    enabled: false
    type: platform
    name: chatrecall
    description: Search past conversations and load session summaries for contextual memory
    display_name: Chat Recall
    bundled: true
    available_tools: []
  extensionmanager:
    enabled: false
    type: platform
    name: Extension Manager
    description: Enable extension management tools for discovering, enabling, and disabling extensions
    display_name: Extension Manager
    bundled: true
    available_tools: []
  code_execution:
    enabled: false
    type: platform
    name: code_execution
    description: Goose will make extension calls through code execution, saving tokens
    display_name: Code Mode
    bundled: true
    available_tools: []
  apps:
    enabled: false
    type: platform
    name: apps
    description: Create and manage custom Goose apps through chat. Apps are HTML/CSS/JavaScript and run in sandboxed windows.
    display_name: Apps
    bundled: true
    available_tools: []
  tom:
    enabled: false
    type: platform
    name: tom
    description: Inject custom context into every turn via GOOSE_MOIM_MESSAGE_TEXT and GOOSE_MOIM_MESSAGE_FILE environment variables
    display_name: Top Of Mind
    bundled: true
    available_tools: []
`,
  );

  // Symlink data dir to the real one so models/registry are found
  if (!existsSync(dataDir)) {
    const realData = gooseDataDir();
    if (realData && existsSync(realData)) {
      symlinkSync(realData, dataDir);
    } else {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  return root;
}

/** Default goose data dir (where models live), per etcetera's XDG paths. */
function gooseDataDir(): string | null {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), ".local", "share", "goose");
    case "linux":
      return join(homedir(), ".local", "share", "goose");
    case "win32":
      return join(homedir(), "AppData", "Local", "Block", "goose", "data");
    default:
      return null;
  }
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
    const found = execFileSync("which", ["goose"], {
      encoding: "utf-8",
    }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }

  return null;
}
