#!/usr/bin/env node

import { resolve, join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { takeScreenshot, flushInbox, hasChangedEnough, createBaseBmp, pngToJpegBase64 } from "./screenshot.js";
import { connectAgent, type AgentHandle, type Extraction } from "./agent.js";
import { startBrowser, setBrowserAgent } from "./browser.js";
import { ensurePromptFiles } from "./prompt.js";
import { seedLintQueue, recordChangedFiles, pickLintTarget, markLinted } from "./lint.js";
import { loadSettings } from "./settings.js";
import { getChangedNotes, formatNotesForAgent } from "./notes.js";

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
  const stagingDir = join(config.rootDir, "staging");
  await mkdir(stagingDir, { recursive: true });

  let baseBmpPath: string | null = null;
  let previousPng: string | null = null;

  while (!signal.aborted) {
    try {
      // Capture to staging, not inbox
      const currentPng = await takeScreenshot(stagingDir);

      if (!baseBmpPath) {
        // First screenshot — becomes the base
        baseBmpPath = await createBaseBmp(currentPng);
        previousPng = currentPng;
      } else {
        const { changed, diff } = await hasChangedEnough(currentPng, baseBmpPath);
        if (changed) {
          // Screen changed — emit the previous (stable state before the change)
          if (previousPng) {
            const filename = `screenshot-${Date.now()}.png`;
            await rename(previousPng, join(config.inboxDir, filename));
            console.log(`📸 Screen changed (${(diff * 100).toFixed(1)}% diff) — saved to inbox`);
          }
          // Current becomes the new base
          await unlink(baseBmpPath).catch(() => {});
          baseBmpPath = await createBaseBmp(currentPng);
          previousPng = currentPng;
        } else {
          // No significant change — replace previous with current
          if (previousPng && previousPng !== currentPng) {
            await unlink(previousPng).catch(() => {});
          }
          previousPng = currentPng;
        }
      }
    } catch (err) {
      console.error(`📷 Screenshot failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(config.intervalSecs * 1000);
  }

  // Cleanup
  if (baseBmpPath) await unlink(baseBmpPath).catch(() => {});
  if (previousPng) await unlink(previousPng).catch(() => {});
}

/**
 * Extract loop: pick up PNGs from inbox, send each to the fast model
 * for description, save the text alongside the image.
 */
async function extractLoop(config: Config, agent: AgentHandle, signal: AbortSignal): Promise<void> {
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const files = await readdir(config.inboxDir).catch(() => [] as string[]);
      const pngs = files
        .filter((f) => f.startsWith("screenshot-") && f.endsWith(".png"))
        .sort();

      // Only process PNGs that don't already have a .txt companion
      const unextracted = pngs.filter(
        (f) => !files.includes(f.replace(".png", ".txt")),
      );

      if (unextracted.length === 0) {
        await sleep(3000);
        continue;
      }

      for (const file of unextracted) {
        if (signal.aborted) break;

        const pngPath = join(config.inboxDir, file);
        const txtPath = join(config.inboxDir, file.replace(".png", ".txt"));

        const base64 = await pngToJpegBase64(pngPath);
        const tsMatch = file.match(/screenshot-(\d+)\./);
        const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();

        console.log(`\n${"─".repeat(60)}`);
        console.log(`👁️  Extracting: ${file} (${timestamp.toLocaleTimeString()})`);
        console.log(`${"─".repeat(60)}`);

        const description = await agent.extractScreenshot({
          path: pngPath,
          timestamp,
          base64,
          mimeType: "image/jpeg",
        });

        if (description) {
          await writeFile(txtPath, description, "utf-8");
          console.log(`✅ ${file.replace(".png", ".txt")}`);
        } else {
          console.log(`⏭️  No changes`);
          await unlink(pngPath);
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

async function logUsage(agent: AgentHandle, rootDir: string) {
  const u = agent.getUsage();
  const fmt = (n: number) => n.toLocaleString();
  const cost = u.total.cost > 0 ? ` | 💰 $${u.total.cost.toFixed(4)}` : "";
  const line =
    `📊 Tokens — fast: ${fmt(u.fast.inputTokens)}in/${fmt(u.fast.outputTokens)}out` +
    ` | smart: ${fmt(u.smart.inputTokens)}in/${fmt(u.smart.outputTokens)}out` +
    ` | total: ${fmt(u.total.inputTokens + u.total.outputTokens)}${cost}`;
  console.log(line);

  // Persist to file so usage can be checked externally
  const usageData = {
    timestamp: new Date().toISOString(),
    fast: u.fast,
    smart: u.smart,
    total: u.total,
  };
  await writeFile(
    join(rootDir, "usage.json"),
    JSON.stringify(usageData, null, 2) + "\n",
    "utf-8",
  ).catch(() => {});
}

/**
 * Wiki update loop: pick up .txt extractions from inbox, batch them,
 * send to the smart model for wiki updates, then lint on idle.
 */
/**
 * Compute similarity between two texts using word-level Jaccard index.
 * Returns 0.0 (completely different) to 1.0 (identical words).
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

const SIMILARITY_THRESHOLD = 0.7; // skip if 70%+ similar to last batch

async function wikiLoop(config: Config, agent: AgentHandle, signal: AbortSignal): Promise<void> {
  const BATCH_WAIT_MS = 10_000;  // wait 10s for a batch to accumulate
  const IDLE_WAIT_MS = 15_000;   // wait 15s between wiki checks when idle
  let consecutiveErrors = 0;
  let lastBatchText = "";

  while (!signal.aborted) {
    try {
      const files = await readdir(config.inboxDir).catch(() => [] as string[]);
      const txts = files
        .filter((f) => f.startsWith("screenshot-") && f.endsWith(".txt"))
        .sort();

      if (txts.length === 0) {
        // No extractions pending — check Apple Notes for changes
        try {
          const changedNotes = await getChangedNotes(config.rootDir);
          if (changedNotes.length > 0) {
            const notesCtx = formatNotesForAgent(changedNotes);
            console.log(`\n${"═".repeat(60)}`);
            console.log(`📝 Notes only: ${changedNotes.map(n => n.name).join(", ")}`);
            console.log(`${"═".repeat(60)}`);

            const startTime = Date.now();
            await agent.sendExtractions([], notesCtx);
            await recordChangedFiles(config.rootDir, config.wikiDir, startTime);
            console.log(`\n✅ Notes update complete`);
            logUsage(agent, config.rootDir);
            continue;
          }
        } catch (err) {
          console.error(`📝 Notes check failed:`, err instanceof Error ? err.message : err);
        }

        // No notes changes either — try linting
        const lintTarget = await pickLintTarget(config.rootDir);
        if (lintTarget) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(`🧹 Linting: ${lintTarget}`);
          console.log(`${"─".repeat(60)}`);

          const startTime = Date.now();
          await agent.sendLint(lintTarget);
          await markLinted(config.rootDir, lintTarget);
          await recordChangedFiles(config.rootDir, config.wikiDir, startTime);
          console.log(`\n✅ Lint complete: ${lintTarget}`);
          logUsage(agent, config.rootDir);
        }

        await sleep(IDLE_WAIT_MS);
        continue;
      }

      // Wait a bit for more extractions to arrive before batching
      if (txts.length < config.batchSize) {
        await sleep(BATCH_WAIT_MS);
        // Re-read to pick up any new ones
        const updated = await readdir(config.inboxDir).catch(() => [] as string[]);
        const updatedTxts = updated
          .filter((f) => f.startsWith("screenshot-") && f.endsWith(".txt"))
          .sort();
        // Use whatever we have now
        if (updatedTxts.length > 0) {
          txts.length = 0;
          txts.push(...updatedTxts);
        }
      }

      // Build extraction batch
      const extractions: Extraction[] = [];
      const toCleanup: string[] = [];

      for (const txtFile of txts) {
        const txtPath = join(config.inboxDir, txtFile);
        const pngFile = txtFile.replace(".txt", ".png");
        const pngPath = join(config.inboxDir, pngFile);

        const text = await readFile(txtPath, "utf-8");
        const tsMatch = txtFile.match(/screenshot-(\d+)\./);
        const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();

        extractions.push({ filename: txtFile, timestamp, text });
        toCleanup.push(txtPath);
        toCleanup.push(pngPath); // clean up the PNG too
      }

      // Check if this batch is too similar to the last one we sent
      const batchText = extractions.map(e => e.text).join("\n");
      const similarity = lastBatchText ? textSimilarity(batchText, lastBatchText) : 0;

      // Check Apple Notes for changes
      let notesContext = "";
      try {
        const changedNotes = await getChangedNotes(config.rootDir);
        if (changedNotes.length > 0) {
          notesContext = formatNotesForAgent(changedNotes);
          console.log(`📝 ${changedNotes.length} Apple Note(s) changed: ${changedNotes.map(n => n.name).join(", ")}`);
        }
      } catch (err) {
        console.error(`📝 Notes check failed:`, err instanceof Error ? err.message : err);
      }

      // Skip smart model if content is too similar and no notes changed
      if (similarity >= SIMILARITY_THRESHOLD && !notesContext) {
        console.log(`⏭️  Skipping wiki update — ${(similarity * 100).toFixed(0)}% similar to last batch`);
        // Still clean up the files
        for (const filePath of toCleanup) {
          const filename = filePath.split("/").pop()!;
          await rename(filePath, join(config.processedDir, filename)).catch(() =>
            unlink(filePath).catch(() => {})
          );
        }
        continue;
      }

      console.log(`\n${"═".repeat(60)}`);
      console.log(`🧠 Wiki update: ${extractions.length} extraction(s)${notesContext ? " + notes" : ""}${lastBatchText ? ` (${(similarity * 100).toFixed(0)}% similar)` : ""}`);
      console.log(`${"═".repeat(60)}`);

      const startTime = Date.now();
      await agent.sendExtractions(extractions, notesContext || undefined);
      lastBatchText = batchText;

      // Track wiki changes for lint queue
      await recordChangedFiles(config.rootDir, config.wikiDir, startTime);

      // Move processed files out
      for (const filePath of toCleanup) {
        const filename = filePath.split("/").pop()!;
        await rename(filePath, join(config.processedDir, filename)).catch(() =>
          unlink(filePath).catch(() => {})
        );
      }

      console.log(`\n✅ Wiki update complete — processed ${extractions.length} extraction(s)`);
      logUsage(agent, config.rootDir);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(`❌ Wiki update error:`, err instanceof Error ? err.message : err);

      if (consecutiveErrors > 5) {
        console.error("⏳ Too many errors, backing off 60s…");
        await sleep(60_000);
      } else {
        await sleep(10_000);
      }
    }
  }
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
    console.log("\n👋 Shutting down…");
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
    wikiLoop(config, agent, signal),
    sleep(2000).then(() => screenshotLoop(config, signal)),
  ]);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
