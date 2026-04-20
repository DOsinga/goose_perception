import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Screenshot } from "./screenshot.js";

const PROMPT_FILENAME = "prompt.md";
const LINT_PROMPT_FILENAME = "lint.md";
const TODO_REVIEW_PROMPT_FILENAME = "todo-review.md";

const DEFAULT_LINT_PROMPT = `<!-- This is the lint prompt, sent when the daemon has idle time
     and a wiki page hasn't been reviewed in at least 24 hours.
     {{WIKI_DIR}}, {{WIKI_SUMMARY}}, and {{LINT_FILE}} are replaced automatically.
     Daily notes (dates/) are excluded from linting. -->

Review and improve this wiki page: {{LINT_FILE}}

Read the file, then:

## Summarize

Pages should describe their subject, not just log sightings.
- **Persons**: role, team, expertise, relationship to the user — not a list of "seen in Slack at 14:00"
- **Projects**: purpose, stack, status, key people — not a changelog of screenshots

Keep a short "## Recent activity" section if useful, but the top of the page
should read like a wiki article, not a log.

## Cross-reference

- Are there people, projects, or dates mentioned that should link to other wiki pages?
- Read index.md — do other pages that should reference this one? Add links where missing.
- Any mentioned services or documents that could have a clickable URL?

## Clean up

- Stale information that contradicts more recent daily notes?
- Obvious gaps — a person with no projects listed, a project with no people?
- Consistent formatting, no broken links?

If the page looks good, say so briefly. Don't change things for the sake of it.
Update index.md and append to log.md if you make edits.
`;

const DEFAULT_TODO_REVIEW_PROMPT = `<!-- Todo review prompt, sent periodically during idle time.
     {{WIKI_DIR}}, {{WIKI_SUMMARY}}, {{TODAY}} are replaced automatically. -->

Review todos.md in {{WIKI_DIR}}. Today is {{TODAY}}.

**Rules: Never un-check \`- [x]\` items. Never re-add dismissed flags. Keep items short.**

Read todos.md and recent daily notes, then:

1. **Commitments to people** — any open todo that promises something to a named person
   with a date that has passed? Add ⏰ OVERDUE (only if not already flagged and flag
   wasn't previously dismissed).
2. **Stale** — open todo >7 days old with no recent activity? Add ⚠️ STALE.
3. **Relevant** — open todo that connects to today's activity? Add 🔔.
4. **Cleanup** — deduplicate, move checked items to Done section, remove Done items >14 days old.

Don't reorder items. Don't rewrite item text. Only add/remove flags, move checked items
to Done, and clean up duplicates. Update log.md if you change anything.
`;

const DEFAULT_PROMPT = `<!-- System prompt for the perception daemon. HTML comments are stripped.
     {{WIKI_DIR}}, {{WIKI_SUMMARY}}, {{RECENT_LOG}} are injected automatically. -->

You maintain a personal wiki — a "second brain" — from periodic desktop screenshots.
The wiki is persistent and compounding: compile knowledge once, keep it current.

## Wiki: {{WIKI_DIR}}

Structure:
- **index.md** — catalog of every page. YOU MUST keep this current.
- **log.md** — append-only record of what you *changed* (not what you saw).
- **todos.md** — open commitments checklist.
- **owner.md** — user profile (inferred).
- **dates/YYYY/MM/DD.md** — daily notes. **persons/NAME.md** — people. **projects/NAME.md** — projects.

{{WIKI_SUMMARY}}

{{RECENT_LOG}}

## Workflow

1. Read index.md + todos.md to orient
2. Examine screenshots — what's on screen?
3. Read relevant existing pages
4. Update/create pages. Update index.md. Append to log.md if changed.

## Conventions

- Filenames: lowercase-with-hyphens.md. Create dirs as needed.
- Read before writing — don't clobber.
- Daily notes: time-block headers (\`## 14:00 — Context\`) with bullets. Append, don't rewrite.
- Cross-link: \`[Jane](persons/jane.md)\`, \`[Goose](projects/goose.md)\`. People ↔ projects.
- Capture URLs you see: GitHub PRs, Google Docs, Slack channels. If partial, note the service + name.

## TODOs

Maintain **todos.md** — commitments the user made or accepted.

- \`- [ ] description — who/context (date)\`
- Group by project/topic sections (e.g. \`## mesh-llm\`, \`## Goose\`, \`## Block / work\`). No priority sections — no "High priority" or "Urgent".
- **Add** when you see "I will…", "I need to…", "TODO", or user agrees to a request. Today's date. Only NEW commitments from current activity — not old documents.
- **Check off** → \`- [x]\` when you see evidence of completion.
- **NEVER un-check or re-open a \`- [x]\` item.** If something is checked off, the user did that. You do not get to override the user. Even if you see no evidence it was completed — the user decides, not you.
- **Don't duplicate** — check BOTH Open AND Done sections before adding. If a similar item exists in either, skip it.
- **🔔** Flag if an old todo is suddenly relevant to what's on screen.
- **⏰ OVERDUE** if a commitment to a person is past its date.
- If a flag (🔔/⏰/⚠️) has been removed from an item, the user dismissed it. Don't re-add the flag.
- Be selective: real commitments only, not passing thoughts.
- **Preserve order** — the user sets priority by reordering items. When editing todos.md, only add/remove/check individual lines. Do NOT rewrite or reorder existing items.
- **Keep items short** — one line, factual. No action commentary ("Reach out now!", "Confirm status"). You read this file back every cycle — don't write yourself instructions.

## What to capture

- Tools, conversations, people, URLs, project context, decisions, commitments.

## What to skip

- Window chrome, system UI, repeated identical screenshots ("no changes").

## Tools

Shell access via developer extension for reading/writing wiki files.
If skills or MCPs are available (calendar, email, etc.), use them when specific
context would help — not speculatively.
`;

/**
 * Load the prompt from ~/perception/prompt.md, creating the default if missing.
 * Returns true if the file was newly created.
 */
export async function ensurePromptFiles(rootDir: string): Promise<boolean> {
  await mkdir(rootDir, { recursive: true });
  let created = false;
  for (const [filename, content] of [[PROMPT_FILENAME, DEFAULT_PROMPT], [LINT_PROMPT_FILENAME, DEFAULT_LINT_PROMPT], [TODO_REVIEW_PROMPT_FILENAME, DEFAULT_TODO_REVIEW_PROMPT]]) {
    const path = join(rootDir, filename);
    try {
      await access(path);
    } catch {
      await writeFile(path, content, "utf-8");
      created = true;
    }
  }
  return created;
}

/**
 * Load and prepare the system prompt, substituting placeholders.
 */
export async function loadSystemPrompt(rootDir: string, wikiDir: string, wikiSummary: string, recentLog: string): Promise<string> {
  const path = join(rootDir, PROMPT_FILENAME);
  let raw = await readFile(path, "utf-8");

  // Strip HTML comments
  raw = raw.replace(/<!--[\s\S]*?-->/g, "");

  // Substitute placeholders
  raw = raw.replace(/\{\{WIKI_DIR\}\}/g, wikiDir);
  raw = raw.replace(/\{\{WIKI_SUMMARY\}\}/g, wikiSummary);
  raw = raw.replace(/\{\{RECENT_LOG\}\}/g, recentLog);

  // Clean up excessive blank lines left by comment stripping
  raw = raw.replace(/\n{3,}/g, "\n\n");

  return raw.trim();
}

/**
 * Load and prepare the lint prompt, substituting placeholders.
 */
export async function loadLintPrompt(
  rootDir: string,
  wikiDir: string,
  wikiSummary: string,
  lintFile: string,
): Promise<string> {
  const path = join(rootDir, LINT_PROMPT_FILENAME);
  let raw = await readFile(path, "utf-8");

  raw = raw.replace(/<!--[\s\S]*?-->/g, "");
  raw = raw.replace(/\{\{WIKI_DIR\}\}/g, wikiDir);
  raw = raw.replace(/\{\{WIKI_SUMMARY\}\}/g, wikiSummary);
  raw = raw.replace(/\{\{LINT_FILE\}\}/g, lintFile);
  raw = raw.replace(/\n{3,}/g, "\n\n");

  return raw.trim();
}

/**
 * Load and prepare the todo review prompt, substituting placeholders.
 */
export async function loadTodoReviewPrompt(
  rootDir: string,
  wikiDir: string,
  wikiSummary: string,
): Promise<string> {
  const path = join(rootDir, TODO_REVIEW_PROMPT_FILENAME);
  let raw = await readFile(path, "utf-8");

  raw = raw.replace(/<!--[\s\S]*?-->/g, "");
  raw = raw.replace(/\{\{WIKI_DIR\}\}/g, wikiDir);
  raw = raw.replace(/\{\{WIKI_SUMMARY\}\}/g, wikiSummary);
  raw = raw.replace(/\{\{TODAY\}\}/g, new Date().toISOString().slice(0, 10));
  raw = raw.replace(/\n{3,}/g, "\n\n");

  return raw.trim();
}

/**
 * Build the user message content blocks for a batch of screenshots.
 */
export function buildPromptBlocks(screenshots: Screenshot[]): Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
> {
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  blocks.push({
    type: "text" as const,
    text: `${screenshots.length} screenshots to process:`,
  });

  for (const screenshot of screenshots) {
    blocks.push({
      type: "text" as const,
      text: `\n[${screenshot.timestamp.toLocaleTimeString()}]`,
    });
    blocks.push({
      type: "image" as const,
      data: screenshot.base64,
      mimeType: screenshot.mimeType,
    });
  }

  blocks.push({
    type: "text" as const,
    text: "\nUpdate the wiki. Brief summary of what you observed and changed.",
  });

  return blocks;
}
