#!/usr/bin/env node

import { resolve, join } from "node:path";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
import { seedLintQueue } from "./lint.js";
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
  inboxDir: string;
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
    inboxDir: join(rootDir, "inbox"),
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

  // OSC 8 clickable link
  const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

  // Clear screen, move to top
  process.stdout.write("\x1b[2J\x1b[H");

  // White text on dark blue background for the bar
  const text = `  goose perception  ${url}  ${config.wikiDir}  `;
  const pad = Math.max(0, cols - stripAnsi(text).length);
  process.stdout.write(`\x1b[97;44m  goose perception  ${link}  ${config.wikiDir}${" ".repeat(pad)}\x1b[0m\n`);

  // Set scroll region below banner (line 2 onward)
  process.stdout.write(`\x1b[2;${rows}r`);
  process.stdout.write(`\x1b[2;1H`);
}

function restoreTerminal() {
  // Reset scroll region to full terminal
  process.stdout.write("\x1b[r");
}

async function screenshotLoop(config: Config, signal: AbortSignal): Promise<void> {
  const stagingDir = join(config.rootDir, "staging");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(config.screenshotsDir, { recursive: true });

  // Per-window state: base BMP + last PNG for change detection
  const windowState = new Map<number, { baseBmp: string; previousPng: string; info: WindowInfo }>();
  let lastWindowId = 0;

  while (!signal.aborted) {
    try {
      const win = getFrontWindow();
      const windowSwitched = win.windowId !== 0 && win.windowId !== lastWindowId && lastWindowId !== 0;

      // Capture the active window (or full screen if windowId is 0)
      const currentPng = await takeScreenshot(stagingDir, win.windowId || undefined);

      if (windowSwitched) {
        // Window changed — emit the previous window's last screenshot
        const prev = windowState.get(lastWindowId);
        if (prev) {
          const filename = `screenshot-${Date.now()}.png`;
          await rename(prev.previousPng, join(config.screenshotsDir, filename));
          await writeWindowInfo(join(config.screenshotsDir, filename), prev.info);
          console.log(`📸 Window switch (${prev.info.app} → ${win.app}) — saved ${prev.info.app}`);
          await unlink(prev.baseBmp).catch(() => {});
          windowState.delete(lastWindowId);
        }
      }

      lastWindowId = win.windowId || lastWindowId;
      const state = windowState.get(lastWindowId);

      if (!state) {
        // First time seeing this window
        const baseBmp = await createBaseBmp(currentPng);
        windowState.set(lastWindowId, { baseBmp, previousPng: currentPng, info: win });
      } else {
        const { changed, diff } = await hasChangedEnough(currentPng, state.baseBmp);
        if (changed) {
          // Content changed within the same window — emit previous stable state
          const filename = `screenshot-${Date.now()}.png`;
          await rename(state.previousPng, join(config.screenshotsDir, filename));
          await writeWindowInfo(join(config.screenshotsDir, filename), state.info);
          console.log(`📸 Content changed in ${win.app} (${(diff * 100).toFixed(1)}% diff)`);

          await unlink(state.baseBmp).catch(() => {});
          const baseBmp = await createBaseBmp(currentPng);
          windowState.set(lastWindowId, { baseBmp, previousPng: currentPng, info: win });
        } else {
          // No significant change — update previous
          if (state.previousPng !== currentPng) {
            await unlink(state.previousPng).catch(() => {});
          }
          state.previousPng = currentPng;
          state.info = win; // title/url may have changed
        }
      }
    } catch (err) {
      console.error(`📷 Screenshot failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(config.intervalSecs * 1000);
  }

  // Cleanup all window state
  for (const state of windowState.values()) {
    await unlink(state.baseBmp).catch(() => {});
    await unlink(state.previousPng).catch(() => {});
  }
}

/**
 * Extract loop: pick up PNGs from inbox, send each to the fast model
 * for description, save the text alongside the image.
 */
async function extractLoop(config: Config, agent: AgentHandle, signal: AbortSignal): Promise<void> {
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const files = await readdir(config.screenshotsDir).catch(() => [] as string[]);
      const pngs = files
        .filter((f) => f.startsWith("screenshot-") && f.endsWith(".png"))
        .sort();

      if (pngs.length === 0) {
        await sleep(3000);
        continue;
      }

      // If we're falling behind, skip to the most recent 5
      let toProcess = pngs;
      if (toProcess.length > 5) {
        const skipped = toProcess.slice(0, -5);
        toProcess = toProcess.slice(-5);
        for (const f of skipped) {
          await rename(join(config.screenshotsDir, f), join(config.processedDir, f));
          const jf = f.replace(".png", ".json");
          await rename(join(config.screenshotsDir, jf), join(config.processedDir, jf)).catch(() => {});
        }
        console.log(`⏩ Skipped ${skipped.length} old screenshots, processing latest ${toProcess.length}`);
      }

      for (const file of toProcess) {
        if (signal.aborted) break;

        const pngPath = join(config.screenshotsDir, file);

        const base64 = await pngToJpegBase64(pngPath);
        const windowInfo = await readWindowInfo(pngPath);
        const tsMatch = file.match(/screenshot-(\d+)\./);
        const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();

        const label = windowInfo ? `${windowInfo.app} — ${windowInfo.title || "(untitled)"}` : file;
        console.log(`\n${"─".repeat(60)}`);
        console.log(`👁️  ${label} (${timestamp.toLocaleTimeString()})`);
        console.log(`${"─".repeat(60)}`);

        const description = await agent.extractScreenshot({
          path: pngPath,
          timestamp,
          base64,
          mimeType: "image/jpeg",
          windowInfo: windowInfo ?? undefined,
        });

        await mkdir(config.inboxDir, { recursive: true });
        // Move PNG + JSON sidecar to inbox
        await rename(pngPath, join(config.inboxDir, file));
        const jsonFile = file.replace(".png", ".json");
        await rename(join(config.screenshotsDir, jsonFile), join(config.inboxDir, jsonFile)).catch(() => {});

        if (description) {
          await writeFile(join(config.inboxDir, file.replace(".png", ".txt")), description, "utf-8");
          console.log(`✅ ${file.replace(".png", ".txt")}`);
        } else {
          console.log(`⏭️  No changes`);
        }

        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      console.error(`❌ Extract error:`, err instanceof Error ? err.message : err);

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

async function main() {
  const config = parseConfig();

  // Settings override CLI defaults (CLI flags take priority if explicitly set)
  const settings = await loadSettings(config.rootDir);
  if (settings.screenshotIntervalSecs > 0 && config.intervalSecs === DEFAULT_INTERVAL_SECS) {
    config.intervalSecs = settings.screenshotIntervalSecs;
  }

  await ensurePromptFiles(config.rootDir);
  await seedLintQueue(config.rootDir, config.wikiDir);
  const flushed = await flushInbox(config.screenshotsDir, config.processedDir);
  if (flushed > 0) console.log(`🗑️  Flushed ${flushed} stale screenshots`);

  // Start browser and connect agent early so the settings API works
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

  const fast = settings.fastProvider && settings.fastModel
    ? `${settings.fastProvider}/${settings.fastModel}`
    : "default";
  const smart = settings.smartProvider && settings.smartModel
    ? `${settings.smartProvider}/${settings.smartModel}`
    : "default";
  console.log(`⚡ Fast: ${fast}  |  🧠 Smart: ${smart}  |  📷 Every ${config.intervalSecs}s`);

  const abortController = new AbortController();
  const { signal } = abortController;

  const shutdown = () => {
    restoreTerminal();
    const logFile = join(config.rootDir, "last-session.log");
    try {
      writeFileSync(logFile, logLines.join(""));
    } catch { /* best effort */ }
    originalConsoleLog(`\n👋 Shutting down — log written to ${logFile}`);
    abortController.abort();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", () => {
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b[3;${rows}r`);
  });

  await Promise.all([
    extractLoop(config, agent, signal),
    sleep(2000).then(() => screenshotLoop(config, signal)),
  ]);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
