#!/usr/bin/env node

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { takeScreenshot, collectScreenshots, countPending, cleanupProcessed, flushInbox } from "./screenshot.js";
import { connectAgent } from "./agent.js";
import { startBrowser } from "./browser.js";
import { ensurePromptFiles } from "./prompt.js";
import { recordChangedFiles, pickLintTarget, markLinted, seedLintQueue } from "./lint.js";
import { loadSettings } from "./settings.js";

const DEFAULT_INTERVAL_SECS = 5;
const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_ROOT = join(homedir(), "perception");
const BROWSER_PORT = 8112;

interface Config {
  intervalSecs: number;
  batchSize: number;
  rootDir: string;
  wikiDir: string;
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
  while (!signal.aborted) {
    try {
      await takeScreenshot(config.inboxDir);
    } catch (err) {
      console.error(`📷 Screenshot failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(config.intervalSecs * 1000);
  }
}

async function agentLoop(config: Config, signal: AbortSignal): Promise<void> {
  console.log("🤝 Connecting to goose…");
  const agent = await connectAgent({
    rootDir: config.rootDir,
    wikiDir: config.wikiDir,
    serverUrl: config.serverUrl,
  });
  console.log("✅ Agent connected\n");

  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const pending = await countPending(config.inboxDir);

      if (pending < config.batchSize) {
        await sleep(2000);
        continue;
      }

      const screenshots = await collectScreenshots(config.inboxDir, config.processedDir);
      if (screenshots.length === 0) {
        await sleep(2000);
        continue;
      }

      const timeRange = `${screenshots[0]!.timestamp.toLocaleTimeString()}–${screenshots[screenshots.length - 1]!.timestamp.toLocaleTimeString()}`;
      console.log(`\n${"─".repeat(60)}`);
      console.log(`📸 ${screenshots.length} screenshots (${timeRange})`);
      console.log(`${"─".repeat(60)}`);

      const startTime = Date.now();
      await agent.sendScreenshots(screenshots);
      console.log("");
      consecutiveErrors = 0;

      const hadChanges = await recordChangedFiles(config.rootDir, config.wikiDir, startTime);
      if (hadChanges) {
        console.log("📋 Changes queued for lint");
      } else {
        // Nothing changed — try linting
        const target = await pickLintTarget(config.rootDir);
        if (target) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(`🧹 Linting: ${target}`);
          console.log(`${"─".repeat(60)}`);
          try {
            await agent.sendLint(target);
            await markLinted(config.rootDir, target);
            console.log("");
          } catch (err) {
            console.error(`🧹 Lint error:`, err instanceof Error ? err.message : err);
          }
        }
      }

      await cleanupProcessed(config.processedDir);
    } catch (err) {
      consecutiveErrors++;
      console.error(`❌ Error:`, err instanceof Error ? err.message : err);

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
  const flushed = await flushInbox(config.inboxDir, config.processedDir);
  if (flushed > 0) console.log(`🗑️  Flushed ${flushed} stale screenshots from inbox`);
  printBanner(config);

  await startBrowser(config.rootDir, config.wikiDir);

  const abortController = new AbortController();
  const { signal } = abortController;

  const shutdown = () => {
    restoreTerminal();
    console.log("\n👋 Shutting down…");
    abortController.abort();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", () => {
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b[4;${rows}r`);
  });

  await Promise.all([
    agentLoop(config, signal),
    sleep(2000).then(() => screenshotLoop(config, signal)),
  ]);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
