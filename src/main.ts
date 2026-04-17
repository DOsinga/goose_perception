#!/usr/bin/env node

import { resolve, join } from "node:path";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import {
  takeScreenshot, flushInbox, hasChangedEnough, createBaseBmp,
  pngToJpegBase64, getFrontWindow, writeWindowInfo, readWindowInfo,
  type WindowInfo,
} from "./screenshot.js";
import { connectAgent, type AgentHandle } from "./agent.js";
import { startBrowser, setBrowserAgent } from "./browser.js";
import { ensurePromptFiles } from "./prompt.js";
import { seedLintQueue, recordChangedFiles, pickLintTarget, markLinted } from "./lint.js";
import { loadSettings } from "./settings.js";

// Capture all output to a log file
const logLines: string[] = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
  if (typeof chunk === "string") logLines.push(chunk);
  return (originalStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...args);
};
const originalConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  logLines.push(args.map(String).join(" ") + "\n");
  originalConsoleLog(...args);
};

const DEFAULT_INTERVAL_SECS = 5;
const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_ROOT = join(homedir(), "perception");
const BROWSER_PORT = 8112;

interface Config {
  intervalSecs: number;
  batchSize: number;
  rootDir: string;
  wikiDir: string;
  screenshotsDir: string;
  processedDir: string;
  serverUrl?: string;
}

function parseConfig(): Config {
  const { values } = parseArgs({
    options: {
      interval: { type: "string", short: "i", default: String(DEFAULT_INTERVAL_SECS) },
      batch: { type: "string", short: "b", default: String(DEFAULT_BATCH_SIZE) },
      root: { type: "string", short: "r", default: DEFAULT_ROOT },
      server: { type: "string", short: "s" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
autowiki — desktop screenshot → personal wiki daemon

Usage: autowiki [options]

Options:
  -i, --interval <secs>   Screenshot interval (default: ${DEFAULT_INTERVAL_SECS}s)
  -b, --batch <count>     Min screenshots per batch (default: ${DEFAULT_BATCH_SIZE})
  -r, --root <dir>        Root directory (default: ~/perception)
  -s, --server <url>      Goose server URL (default: spawn via ACP stdio)
  -h, --help              Show this help
`);
    process.exit(0);
  }

  const rootDir = resolve(values.root!);
  return {
    intervalSecs: parseInt(values.interval!, 10),
    batchSize: parseInt(values.batch!, 10),
    rootDir,
    wikiDir: join(rootDir, "wiki"),
    screenshotsDir: join(rootDir, "screenshots"),
    processedDir: join(rootDir, "processed"),
    serverUrl: values.server,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

function printBanner(config: Config) {
  const url = `http://localhost:${BROWSER_PORT}`;
  const rows = process.stdout.rows ?? 24;
  const cols = process.stdout.columns ?? 80;

  const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

  process.stdout.write("\x1b[2J\x1b[H");
  const text = `  goose perception  ${url}  ${config.wikiDir}  `;
  const pad = Math.max(0, cols - stripAnsi(text).length);
  process.stdout.write(`\x1b[97;44m  goose perception  ${link}  ${config.wikiDir}${" ".repeat(pad)}\x1b[0m\n`);
  process.stdout.write(`\x1b[2;${rows}r`);
  process.stdout.write(`\x1b[2;1H`);
}

function restoreTerminal() {
  process.stdout.write("\x1b[r");
}

// ── Screenshot loop ──

async function screenshotLoop(config: Config, signal: AbortSignal): Promise<void> {
  const stagingDir = join(config.rootDir, "staging");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(config.screenshotsDir, { recursive: true });

  const windowState = new Map<number, { baseBmp: string; previousPng: string; info: WindowInfo }>();
  let lastWindowId = 0;

  while (!signal.aborted) {
    try {
      const win = getFrontWindow();
      const windowSwitched = win.windowId !== 0 && win.windowId !== lastWindowId && lastWindowId !== 0;

      const currentPng = await takeScreenshot(stagingDir, win.windowId || undefined);

      if (windowSwitched) {
        const prev = windowState.get(lastWindowId);
        if (prev) {
          const filename = `screenshot-${Date.now()}.png`;
          await rename(prev.previousPng, join(config.screenshotsDir, filename));
          await writeWindowInfo(join(config.screenshotsDir, filename), prev.info);
          console.log(`📸 Window switch (${prev.info.app} → ${win.app})`);
          await unlink(prev.baseBmp).catch(() => {});
          windowState.delete(lastWindowId);
        }
      }

      lastWindowId = win.windowId || lastWindowId;
      const state = windowState.get(lastWindowId);

      if (!state) {
        const baseBmp = await createBaseBmp(currentPng);
        windowState.set(lastWindowId, { baseBmp, previousPng: currentPng, info: win });
      } else {
        const { changed, diff } = await hasChangedEnough(currentPng, state.baseBmp);
        if (changed) {
          const filename = `screenshot-${Date.now()}.png`;
          await rename(state.previousPng, join(config.screenshotsDir, filename));
          await writeWindowInfo(join(config.screenshotsDir, filename), state.info);
          console.log(`📸 Content changed in ${win.app} (${(diff * 100).toFixed(1)}% diff)`);

          await unlink(state.baseBmp).catch(() => {});
          const baseBmp = await createBaseBmp(currentPng);
          windowState.set(lastWindowId, { baseBmp, previousPng: currentPng, info: win });
        } else {
          if (state.previousPng !== currentPng) {
            await unlink(state.previousPng).catch(() => {});
          }
          state.previousPng = currentPng;
          state.info = win;
        }
      }
    } catch (err) {
      console.error(`📷 Screenshot failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(config.intervalSecs * 1000);
  }

  for (const state of windowState.values()) {
    await unlink(state.baseBmp).catch(() => {});
    await unlink(state.previousPng).catch(() => {});
  }
}

// ── Agent loop ──

async function agentLoop(config: Config, agent: AgentHandle, signal: AbortSignal): Promise<void> {
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const files = await readdir(config.screenshotsDir).catch(() => [] as string[]);
      const pngs = files
        .filter((f) => f.startsWith("screenshot-") && f.endsWith(".png"))
        .sort();

      if (pngs.length < config.batchSize) {
        // Not enough screenshots yet — try linting if idle
        await tryLint(config, agent);
        await sleep(3000);
        continue;
      }

      // If falling behind, skip to the most recent
      let toProcess = pngs;
      if (toProcess.length > config.batchSize * 2) {
        const skipped = toProcess.slice(0, -config.batchSize);
        toProcess = toProcess.slice(-config.batchSize);
        for (const f of skipped) {
          await rename(join(config.screenshotsDir, f), join(config.processedDir, f));
          await rename(
            join(config.screenshotsDir, f.replace(".png", ".json")),
            join(config.processedDir, f.replace(".png", ".json")),
          ).catch(() => {});
        }
        console.log(`⏩ Skipped ${skipped.length} old, processing latest ${toProcess.length}`);
      }

      // Sample: first, middle, last
      const sampled = [
        toProcess[0]!,
        toProcess[Math.floor(toProcess.length / 2)]!,
        toProcess[toProcess.length - 1]!,
      ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

      // Build screenshots with window info
      const screenshots = await Promise.all(
        sampled.map(async (file) => {
          const pngPath = join(config.screenshotsDir, file);
          const base64 = await pngToJpegBase64(pngPath);
          const windowInfo = await readWindowInfo(pngPath);
          const tsMatch = file.match(/screenshot-(\d+)\./);
          const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();
          return { path: pngPath, timestamp, base64, mimeType: "image/jpeg" as const, windowInfo: windowInfo ?? undefined };
        }),
      );

      // Log what we're processing
      console.log(`\n${"═".repeat(60)}`);
      console.log(`📸 Processing ${sampled.length} screenshots:`);
      for (const s of screenshots) {
        const win = s.windowInfo;
        const label = win ? `${win.app}${win.title ? ` — ${win.title}` : ""}` : "unknown";
        console.log(`   ${s.timestamp.toLocaleTimeString()} ${label}`);
      }
      console.log(`${"═".repeat(60)}`);

      const startTime = Date.now();
      await agent.sendScreenshots(screenshots);

      // Record wiki changes for lint queue
      await recordChangedFiles(config.rootDir, config.wikiDir, startTime);

      // Move all PNGs + sidecars to processed
      for (const f of toProcess) {
        await rename(join(config.screenshotsDir, f), join(config.processedDir, f)).catch(() => {});
        await rename(
          join(config.screenshotsDir, f.replace(".png", ".json")),
          join(config.processedDir, f.replace(".png", ".json")),
        ).catch(() => {});
      }

      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(`❌ Agent error:`, err instanceof Error ? err.message : err);
      if (consecutiveErrors > 5) {
        console.error("⏳ Too many errors, backing off 30s…");
        await sleep(30000);
      } else {
        await sleep(5000);
      }
    }
  }

  agent.shutdown();
}

async function tryLint(config: Config, agent: AgentHandle): Promise<void> {
  const target = await pickLintTarget(config.rootDir);
  if (!target) return;

  console.log(`\n🧹 Linting: ${target}`);
  try {
    await agent.sendLint(target);
    await markLinted(config.rootDir, target);
    console.log(`✅ Lint complete: ${target}`);
  } catch (err) {
    console.error(`❌ Lint failed:`, err instanceof Error ? err.message : err);
  }
}

// ── Main ──

async function main() {
  const config = parseConfig();

  const settings = await loadSettings(config.rootDir);
  if (settings.screenshotIntervalSecs > 0 && config.intervalSecs === DEFAULT_INTERVAL_SECS) {
    config.intervalSecs = settings.screenshotIntervalSecs;
  }

  await ensurePromptFiles(config.rootDir);
  await seedLintQueue(config.rootDir, config.wikiDir);
  const flushed = await flushInbox(config.screenshotsDir, config.processedDir);
  if (flushed > 0) console.log(`🗑️  Flushed ${flushed} stale screenshots`);

  await startBrowser(config.rootDir, config.wikiDir);

  console.log("🤝 Connecting to goose…");
  const agent = await connectAgent({
    rootDir: config.rootDir,
    wikiDir: config.wikiDir,
    serverUrl: config.serverUrl,
    fastProvider: settings.fastProvider || undefined,
    fastModel: settings.fastModel || undefined,
    smartProvider: settings.smartProvider || undefined,
    smartModel: settings.smartModel || undefined,
  });
  setBrowserAgent(agent);
  console.log("✅ Agent connected");

  const needsSetup = !settings.smartProvider || !settings.smartModel;
  if (needsSetup) {
    const settingsUrl = `http://localhost:${BROWSER_PORT}/settings`;
    console.log("⚙️  No models configured — opening settings…");
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [settingsUrl], () => {});

    while (true) {
      await sleep(2000);
      const updated = await loadSettings(config.rootDir);
      if (updated.smartProvider && updated.smartModel) {
        if (updated.screenshotIntervalSecs > 0) {
          config.intervalSecs = updated.screenshotIntervalSecs;
        }
        console.log(`✅ Settings saved — using ${updated.smartProvider}/${updated.smartModel}\n`);
        break;
      }
    }
  }

  printBanner(config);

  const smart = settings.smartProvider && settings.smartModel
    ? `${settings.smartProvider}/${settings.smartModel}`
    : "default";
  console.log(`🧠 Model: ${smart}  |  📷 Every ${config.intervalSecs}s  |  📦 Batch: ${config.batchSize}`);

  const abortController = new AbortController();
  const { signal } = abortController;

  const shutdown = () => {
    restoreTerminal();
    const logFile = join(config.rootDir, "last-session.log");
    try {
      writeFileSync(logFile, logLines.map(stripAnsi).join(""));
    } catch { /* best effort */ }
    originalConsoleLog(`\n👋 Shutting down — log written to ${logFile}`);
    abortController.abort();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", () => {
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b[2;${rows}r`);
  });

  await Promise.all([
    agentLoop(config, agent, signal),
    sleep(2000).then(() => screenshotLoop(config, signal)),
  ]);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
