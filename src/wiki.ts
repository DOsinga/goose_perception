import { mkdir, readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ensure the wiki directory structure exists.
 */
export async function ensureWikiDirs(wikiDir: string): Promise<void> {
  await mkdir(wikiDir, { recursive: true });
  await mkdir(join(wikiDir, "dates"), { recursive: true });
  await mkdir(join(wikiDir, "persons"), { recursive: true });
  await mkdir(join(wikiDir, "projects"), { recursive: true });
}

/**
 * Read the wiki's index.md if it exists — this is the primary way the agent
 * orients itself. Falls back to a file listing if no index exists yet.
 */
export async function getWikiSummary(wikiDir: string): Promise<string> {
  await ensureWikiDirs(wikiDir);

  // Prefer index.md — the agent-maintained catalog
  const indexPath = join(wikiDir, "index.md");
  try {
    await access(indexPath);
    const index = await readFile(indexPath, "utf-8");
    return `(from index.md)\n${index}`;
  } catch {
    // No index yet — fall back to file listing
  }

  return buildFileListing(wikiDir);
}

/**
 * Build a simple file listing of the wiki for bootstrapping.
 * Once the agent creates index.md, this is no longer used.
 */
async function buildFileListing(wikiDir: string): Promise<string> {
  const lines: string[] = ["(no index.md yet — file listing follows)", ""];

  const entries = await readdir(wikiDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const count = await countMdFiles(join(wikiDir, entry.name));
      lines.push(`${entry.name}/ (${count} files)`);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      lines.push(entry.name);
    }
  }

  if (lines.length <= 2) {
    lines.push("(empty — this is a fresh wiki)");
  }

  return lines.join("\n");
}

/**
 * Read the last N entries from log.md.
 */
export async function getRecentLog(wikiDir: string, count: number = 20): Promise<string> {
  const logPath = join(wikiDir, "log.md");
  try {
    const content = await readFile(logPath, "utf-8");
    const entries = content.split(/^(?=## \[)/m).filter((e) => e.trim());
    const recent = entries.slice(-count);
    return recent.length > 0 ? recent.join("") : "(no log entries yet)";
  } catch {
    return "(no log.md yet)";
  }
}

async function countMdFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countMdFiles(join(dir, entry.name));
      } else if (entry.name.endsWith(".md")) {
        count++;
      }
    }
  } catch {
    // directory might not exist
  }
  return count;
}
