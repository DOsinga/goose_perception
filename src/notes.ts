import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface NoteSnapshot {
  name: string;
  plaintext: string;
  modifiedAt: Date;
}

const STATE_FILENAME = "notes-state.json";

interface NotesState {
  /** Map of note name → ISO timestamp of last seen modification date */
  lastSeen: Record<string, string>;
}

async function loadState(rootDir: string): Promise<NotesState> {
  try {
    const raw = await readFile(join(rootDir, STATE_FILENAME), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastSeen: {} };
  }
}

async function saveState(rootDir: string, state: NotesState): Promise<void> {
  await writeFile(
    join(rootDir, STATE_FILENAME),
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Run an AppleScript via osascript and return stdout.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`osascript failed: ${err.message}\n${stderr}`));
      else resolve(stdout.trimEnd());
    });
  });
}

/**
 * Get the names and modification dates of recently modified notes.
 * Returns up to `limit` notes, sorted by most recently modified.
 */
async function getRecentNoteMeta(limit: number = 50): Promise<Array<{ name: string; modifiedAt: Date }>> {
  // AppleScript returns tab-separated name\tdate pairs, one per line
  const script = `
    tell application "Notes"
      set output to ""
      set noteCount to count of notes
      if noteCount > ${limit} then set noteCount to ${limit}
      repeat with i from 1 to noteCount
        set n to note i
        set noteName to name of n
        set modDate to modification date of n
        set output to output & noteName & tab & (modDate as string) & linefeed
      end repeat
      return output
    end tell
  `;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  const results: Array<{ name: string; modifiedAt: Date }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const tabIdx = line.lastIndexOf("\t");
    if (tabIdx < 0) continue;
    const name = line.substring(0, tabIdx);
    const dateStr = line.substring(tabIdx + 1);
    const modifiedAt = new Date(dateStr);
    if (!isNaN(modifiedAt.getTime())) {
      results.push({ name, modifiedAt });
    }
  }
  return results;
}

/**
 * Get the plaintext content of a note by name.
 */
async function getNoteContent(name: string): Promise<string> {
  // Escape single quotes for AppleScript
  const escaped = name.replace(/'/g, "'\"'\"'");
  const script = `
    tell application "Notes"
      set n to first note whose name is '${escaped}'
      return plaintext of n
    end tell
  `;
  return runAppleScript(script);
}

/**
 * Check Apple Notes for changes since last check.
 * Returns an array of notes that have been modified or created since
 * they were last seen, with their full plaintext content.
 */
export async function getChangedNotes(rootDir: string): Promise<NoteSnapshot[]> {
  if (process.platform !== "darwin") return [];

  const state = await loadState(rootDir);
  const metas = await getRecentNoteMeta(50);
  const changed: NoteSnapshot[] = [];

  for (const meta of metas) {
    const lastSeen = state.lastSeen[meta.name];
    const modIso = meta.modifiedAt.toISOString();

    // Skip if we've already seen this version
    if (lastSeen && lastSeen >= modIso) continue;

    // Skip notes with generic/unhelpful names
    if (meta.name === "New Note" || meta.name.startsWith("Saved Photo") || meta.name.startsWith("Saved Video")) {
      continue;
    }

    try {
      const plaintext = await getNoteContent(meta.name);
      // Skip very short or empty notes
      if (plaintext.trim().length < 20) continue;

      changed.push({
        name: meta.name,
        plaintext,
        modifiedAt: meta.modifiedAt,
      });

      // Cap at 5 changed notes per check to avoid overwhelming the agent
      if (changed.length >= 5) break;
    } catch {
      // Note may have been deleted between listing and fetching
    }
  }

  // Update state for all notes we checked (not just changed ones)
  for (const meta of metas) {
    state.lastSeen[meta.name] = meta.modifiedAt.toISOString();
  }
  await saveState(rootDir, state);

  return changed;
}

/**
 * Format changed notes into text suitable for the wiki agent.
 */
export function formatNotesForAgent(notes: NoteSnapshot[]): string {
  if (notes.length === 0) return "";

  let text = `${notes.length} Apple Notes changed:\n\n`;
  for (const note of notes) {
    text += `--- Note: "${note.name}" (modified ${note.modifiedAt.toLocaleString()}) ---\n`;
    // Truncate very long notes
    const content = note.plaintext.length > 3000
      ? note.plaintext.substring(0, 3000) + "\n[... truncated ...]"
      : note.plaintext;
    text += content + "\n\n";
  }
  return text;
}
