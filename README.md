# goose_perception

Desktop screenshot → personal wiki daemon powered by [Goose](https://github.com/aaif-goose/goose).

Screenshots your desktop periodically, feeds them to a Goose agent that builds and maintains a personal wiki — a linked collection of markdown files about your projects, people, and daily activity.

## Quick start

```bash
npx goose_perception
```

That's it. Opens a wiki browser at http://localhost:8112 and starts capturing.

## Requirements

- **Node.js** 20+
- **Goose** — either on PATH (`brew install goose`) or auto-installed via the npm package
- **macOS** or **Linux** (screenshot tools: `screencapture` on macOS, `gnome-screenshot`/`scrot` on Linux)
- A vision-capable model configured in goose (e.g. Claude, GPT-4o, Gemini)

## Options

```
  -i, --interval <secs>   Screenshot interval (default: 5s)
  -b, --batch <count>     Min screenshots per batch (default: 3)
  -r, --root <dir>        Root directory (default: ~/perception)
  -s, --server <url>      Goose server URL (default: spawn via ACP stdio)
```

## Directory layout

```
~/perception/
├── prompt.md        System prompt — edit to change agent behavior
├── lint.md          Lint prompt — edit to change how pages get reviewed
├── tolint.json      Lint queue state
├── wiki/            The wiki itself
│   ├── index.md     Agent-maintained catalog of all pages
│   ├── log.md       Append-only record of wiki changes
│   ├── owner.md     Profile of the user
│   ├── dates/       Daily notes (dates/2025/07/13.md)
│   ├── persons/     People (persons/jane-doe.md)
│   └── projects/    Projects (projects/goose.md)
├── inbox/           Screenshots waiting to be processed
└── processed/       Screenshots already sent to the agent
```

## How it works

1. **Screenshot loop** captures your desktop every N seconds
2. **Agent loop** batches screenshots (samples first/middle/last to cap at 3), feeds them to Goose with the wiki context
3. The agent reads existing wiki pages, updates or creates new ones, maintains cross-references
4. When a batch produces no wiki changes, the agent **lints** the oldest unreviewed page — summarizing, cross-referencing, cleaning up
5. A built-in web server lets you browse, search, and edit the wiki at http://localhost:8112

## Customization

Edit `~/perception/prompt.md` to change what the agent captures and how it organizes the wiki. HTML comments (`<!-- ... -->`) are stripped before sending to the model — use them as annotations for yourself.

Edit `~/perception/lint.md` to change how pages get reviewed during idle time.

Both are editable in the browser at `/prompt` and `/lint`.

## Agent skill (optional)

The repo includes a `SKILL.md` that lets other agents (Claude Code, Goose, etc.) use your wiki as context. Install it to give your agents knowledge of who you are, what you're working on, and what you've committed to do.

```bash
mkdir -p ~/.claude/skills/perception-wiki
ln -sfn "$(pwd)/SKILL.md" ~/.claude/skills/perception-wiki/SKILL.md
```

Agents that scan `~/.claude/skills/` will pick it up automatically. For CLI use with Claude Code, pass `--add-dir ~/perception/wiki` so the wiki files are accessible.

## License

Apache-2.0
