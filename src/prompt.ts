import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Screenshot } from "./screenshot.js";

const PROMPT_FILENAME = "prompt.md";
const LINT_PROMPT_FILENAME = "lint.md";
const TODO_REVIEW_PROMPT_FILENAME = "todo-review.md";
const REFLECT_PROMPT_FILENAME = "reflect.md";

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

**Rules: Never un-check \`- [x]\` items. Don't rewrite or reorder existing items.**

Read todos.md, then:

1. **Move checked items** — any \`- [x]\` outside the Done section? Move it there.
2. **Deduplicate** — same todo in multiple sections? Keep one, remove the other.
3. **Old done items** — Done items >14 days old? Remove them.

That's it. Don't add flags, don't rewrite text, don't reorder. Update log.md if you change anything.
`;

const DEFAULT_REFLECT_PROMPT = `<!-- Daily reflection prompt, runs once a day (or after heavy meeting/voice activity).
     {{WIKI_DIR}}, {{WIKI_SUMMARY}}, {{TODAY}}, {{TODAYS_PAGE}} are replaced automatically. -->

This is a daily reflection pass. Today is {{TODAY}}.

## Setup

Read these files thoroughly before making any changes:

1. {{TODAYS_PAGE}} — today's date page
2. todos.md — current commitments
3. owner.md — user profile

Then read any person or project pages referenced in today's date page.

Take your time. This is a reflection, not a speed run.

## Wiki: {{WIKI_DIR}}

{{WIKI_SUMMARY}}

## Reflection tasks

### a) Implicit commitments & follow-ups

Look for things that aren't phrased as "I will..." but imply action:
- Someone asked a question and the user didn't say no
- A discussion about "we should..." with no pushback
- Meeting notes that mention next steps assigned to or accepted by the user
- Voice transcripts are especially rich here — "yeah I can look at that", "let me check", "I'll circle back"

Be selective — only add todos that are genuinely implied, not speculative.
Add them to todos.md with the annotation \`(inferred from reflection)\` and today's date.
Don't duplicate anything already in todos.md (check both Open and Done sections).

### b) Decisions made

Scan for decisions that were made (explicitly or by consensus) but not yet captured
as facts on project or person pages. Examples:
- "We're going with Postgres" → update the project page's stack/status
- "Jane will own the migration" → update Jane's person page and the project page
- A meeting where an approach was chosen but only logged as a time-block bullet

Update the relevant wiki pages with the decision as a fact, not as a log entry.

### c) Open threads

Identify conversations or topics that were started but not resolved:
- Someone asked something and there's no answer captured
- A discussion was cut short or deferred ("let's talk about this later")
- A question the user asked that hasn't been answered yet

Add these as a \`## Open threads\` section in today's date page ({{TODAYS_PAGE}}).
Keep each item to one or two lines — what was asked, by whom, and what's unresolved.

### d) People context

Did the user interact with someone new or learn something significant about an
existing person? Update person pages with relationship context:
- Role, expertise, what they're working on, how they relate to the user
- Not just "seen at 14:00" — meaningful context that's useful tomorrow

### e) Owner insights

Any new patterns about the user — what they care about, how they work, recurring
themes in their day. Update owner.md sparingly: only genuine insights, not noise.
If nothing stands out, skip this step entirely.

### f) Tomorrow prep

Based on today's activity, are there things the user should be aware of tomorrow?
- Deadlines approaching
- Follow-ups that are due
- Context they'll need for scheduled meetings
- Threads that need resolution

Add a \`## Tomorrow\` section to today's date page ({{TODAYS_PAGE}}).

## Important guidelines

- **Read thoroughly before writing** — understand the full day before changing anything.
- **Don't duplicate** anything already captured by the real-time observation loop.
- **Be selective** — fewer high-quality additions beat many speculative ones.
- **Voice transcripts** are the richest source for implicit commitments. Pay close attention.
- Append to log.md with a summary of what this reflection pass changed.
`;

const DEFAULT_PROMPT = `<!-- System prompt for the perception daemon. HTML comments are stripped.
     {{WIKI_DIR}}, {{WIKI_SUMMARY}}, {{RECENT_LOG}} are injected automatically. -->

You maintain a personal wiki — a "second brain" — from periodic desktop screenshots.
The wiki is persistent and compounding: compile knowledge once, keep it current.

## Wiki: {{WIKI_DIR}}

Structure:
- **log.md** — append-only record of what you *changed* (not what you saw).
- **todos.md** — open commitments checklist.
- **owner.md** — user profile (inferred).
- **dates/YYYY/MM/DD.md** — daily notes. **persons/NAME.md** — people. **projects/NAME.md** — projects.

{{WIKI_SUMMARY}}

{{RECENT_LOG}}

## Workflow

1. Read todos.md and list wiki files to orient
2. Examine screenshots — what's on screen?
3. Read relevant existing pages
4. Update/create pages. Append to log.md if changed.

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
- **NEVER un-check or re-open a \`- [x]\` item.** The user decides what's done, not you.
- **Don't duplicate** — check BOTH Open AND Done before adding.
- Be selective: real commitments only, not passing thoughts.
- **Don't rewrite or reorder** existing items. Only add new lines or check off existing ones.
- **Keep items short** — one line, factual. No commentary or self-instructions.

## What to capture

- Tools, conversations, people, URLs, project context, decisions, commitments.

## Voice Transcripts

You may receive transcripts of what the user said aloud (meetings, thinking
out loud, voice notes). These are especially valuable for:

- **Action items & commitments** — "I'll send that by Friday" → add to todos.md
- **Decisions** — "Let's go with approach B" → note in the relevant project page
- **People context** — who was in the meeting, what they said
- **Project updates** — status discussed verbally that may not appear on screen

Voice transcripts are noisy — expect filler words, false starts, and
transcription errors. Extract the signal, ignore the noise.
When voice and screenshots overlap in time, they're complementary:
the screenshot shows what's on screen, the voice shows what's being discussed.

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
  for (const [filename, content] of [[PROMPT_FILENAME, DEFAULT_PROMPT], [LINT_PROMPT_FILENAME, DEFAULT_LINT_PROMPT], [TODO_REVIEW_PROMPT_FILENAME, DEFAULT_TODO_REVIEW_PROMPT], [REFLECT_PROMPT_FILENAME, DEFAULT_REFLECT_PROMPT]]) {
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
 * Load and prepare the daily reflection prompt, substituting placeholders.
 */
export async function loadReflectPrompt(
  rootDir: string,
  wikiDir: string,
  wikiSummary: string,
): Promise<string> {
  const path = join(rootDir, REFLECT_PROMPT_FILENAME);
  let raw = await readFile(path, "utf-8");

  const today = new Date().toISOString().slice(0, 10);
  const [year, month, day] = today.split("-");
  const todaysPage = `dates/${year}/${month}/${day}.md`;

  raw = raw.replace(/<!--[\s\S]*?-->/g, "");
  raw = raw.replace(/\{\{WIKI_DIR\}\}/g, wikiDir);
  raw = raw.replace(/\{\{WIKI_SUMMARY\}\}/g, wikiSummary);
  raw = raw.replace(/\{\{TODAY\}\}/g, today);
  raw = raw.replace(/\{\{TODAYS_PAGE\}\}/g, todaysPage);
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
