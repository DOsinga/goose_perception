import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const TOLINT_FILENAME = "tolint.json";
const LINT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

interface LintEntry {
  lastLinted: string | null; // ISO timestamp or null if never linted
  editsSinceLinted: number;
}

type LintQueue = Record<string, LintEntry>;

async function loadQueue(rootDir: string): Promise<LintQueue> {
  try {
    const raw = await readFile(join(rootDir, TOLINT_FILENAME), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveQueue(rootDir: string, queue: LintQueue): Promise<void> {
  await writeFile(join(rootDir, TOLINT_FILENAME), JSON.stringify(queue, null, 2) + "\n", "utf-8");
}

function isLintable(file: string): boolean {
  if (file.startsWith("dates")) return false;
  if (file === "index.md" || file === "log.md") return false;
  return true;
}

/**
 * Walk the wiki and collect mtimes for lintable .md files.
 */
async function collectMtimes(wikiDir: string): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  await walk(wikiDir, wikiDir, mtimes);
  return mtimes;
}

async function walk(dir: string, wikiDir: string, mtimes: Map<string, number>): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("tmp_")) continue;
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiDir, fullPath);
      if (!isLintable(rel)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath, wikiDir, mtimes);
      } else if (entry.name.endsWith(".md")) {
        const s = await stat(fullPath);
        mtimes.set(rel, s.mtimeMs);
      }
    }
  } catch {
    // directory might not exist
  }
}

/**
 * After a screenshot batch: find files modified since startTime,
 * increment editsSinceLinted for each.
 * Returns true if any wiki files changed.
 */
export async function recordChangedFiles(
  rootDir: string,
  wikiDir: string,
  startTime: number,
): Promise<boolean> {
  const mtimes = await collectMtimes(wikiDir);
  const changed: string[] = [];

  for (const [file, mtime] of mtimes) {
    if (mtime >= startTime) {
      changed.push(file);
    }
  }

  if (changed.length === 0) return false;

  const queue = await loadQueue(rootDir);
  for (const file of changed) {
    const entry = queue[file];
    if (entry) {
      entry.editsSinceLinted++;
    } else {
      queue[file] = { lastLinted: null, editsSinceLinted: 1 };
    }
  }
  await saveQueue(rootDir, queue);
  return true;
}

/**
 * On startup: scan the wiki and seed any files not yet in the queue
 * with editsSinceLinted: 1 so they get an initial lint pass.
 */
export async function seedLintQueue(rootDir: string, wikiDir: string): Promise<void> {
  const mtimes = await collectMtimes(wikiDir);
  if (mtimes.size === 0) return;

  const queue = await loadQueue(rootDir);
  let added = 0;
  for (const file of mtimes.keys()) {
    if (!(file in queue)) {
      queue[file] = { lastLinted: null, editsSinceLinted: 1 };
      added++;
    }
  }
  if (added > 0) {
    await saveQueue(rootDir, queue);
  }
}

/**
 * Pick the best lint target: must have editsSinceLinted > 0 and
 * lastLinted either null or at least 24h ago. Among those, pick
 * the one with the oldest lastLinted (never-linted first).
 */
export async function pickLintTarget(rootDir: string): Promise<string | null> {
  const queue = await loadQueue(rootDir);
  const now = Date.now();

  let best: { file: string; time: number } | null = null;

  for (const [file, entry] of Object.entries(queue)) {
    if (entry.editsSinceLinted <= 0) continue;

    let lintedAt: number;
    if (entry.lastLinted === null) {
      lintedAt = 0; // never linted — highest priority
    } else {
      lintedAt = new Date(entry.lastLinted).getTime();
      if (now - lintedAt < LINT_COOLDOWN_MS) continue; // too recent
    }

    if (!best || lintedAt < best.time) {
      best = { file, time: lintedAt };
    }
  }

  return best?.file ?? null;
}

/**
 * Mark a file as linted: set lastLinted to now, reset editsSinceLinted to 0.
 */
export async function markLinted(rootDir: string, file: string): Promise<void> {
  const queue = await loadQueue(rootDir);
  queue[file] = {
    lastLinted: new Date().toISOString(),
    editsSinceLinted: 0,
  };
  await saveQueue(rootDir, queue);
}
