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
- **ffmpeg** (optional, for voice capture) — `brew install ffmpeg`

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
├── settings.json    Model, capture, and voice settings
├── wiki/            The wiki itself
│   ├── index.md     Agent-maintained catalog of all pages
│   ├── log.md       Append-only record of wiki changes
│   ├── owner.md     Profile of the user
│   ├── dates/       Daily notes (dates/2025/07/13.md)
│   ├── persons/     People (persons/jane-doe.md)
│   └── projects/    Projects (projects/goose.md)
├── inbox/           Screenshots & voice transcripts waiting to be processed
├── processed/       Files already sent to the agent
└── audio/           Temporary voice capture (deleted after transcription)
    ├── chunks/      WAV files from mic (auto-deleted)
    └── processed/   Failed transcriptions (for debugging)
```

## How it works

1. **Screenshot loop** captures your desktop every N seconds
2. **Extract loop** sends each screenshot to a fast model for text extraction
3. **Mic loop** (optional) records audio in 30-second chunks, skips silence via VAD
4. **Transcribe loop** sends voice chunks to Whisper (API, local, or macOS built-in) for transcription
5. **Wiki loop** batches screenshot extractions + voice transcripts + Apple Notes changes, sends them to a smart model that updates the wiki
6. When idle, the agent **lints** the oldest unreviewed page — summarizing, cross-referencing, cleaning up
7. A built-in web server lets you browse, search, and edit the wiki at http://localhost:8112

## Customization

Edit `~/perception/prompt.md` to change what the agent captures and how it organizes the wiki. HTML comments (`<!-- ... -->`) are stripped before sending to the model — use them as annotations for yourself.

Edit `~/perception/lint.md` to change how pages get reviewed during idle time.

Both are editable in the browser at `/prompt` and `/lint`.

## Voice capture

Voice capture is **off by default**. Enable it in the settings page at http://localhost:8112/settings.

Three transcription backends are supported:

| Backend | Cost | Privacy | Setup |
|---------|------|---------|-------|
| **OpenAI Whisper API** | ~$0.006/min | Audio sent to OpenAI | Set `OPENAI_API_KEY` env var |
| **Local whisper.cpp** | Free | Fully local | `brew install whisper-cpp` |
| **macOS built-in** | Free | Fully local | Nothing (compiles a Swift helper on first use) |

Audio chunks are recorded as mono 16kHz WAV files, checked for voice activity (silence is skipped), transcribed, and then **immediately deleted**. Only the text transcript is kept.

Requires **ffmpeg** for mic capture: `brew install ffmpeg`

## Agent skill (optional)

The repo includes a `SKILL.md` that lets other agents (Claude Code, Goose, etc.) use your wiki as context. Install it to give your agents knowledge of who you are, what you're working on, and what you've committed to do.

```bash
mkdir -p ~/.claude/skills/perception-wiki
ln -sfn "$(pwd)/SKILL.md" ~/.claude/skills/perception-wiki/SKILL.md
```

Agents that scan `~/.claude/skills/` will pick it up automatically. For CLI use with Claude Code, pass `--add-dir ~/perception/wiki` so the wiki files are accessible.

## License

Apache-2.0
