# Voice / Microphone Listening — Design Notes

> Design notes for adding ambient voice capture to goose_perception.
> The goal: capture what the user *says* (meetings, thinking out loud, voice notes)
> alongside what they *see* (screenshots), feeding both into the wiki.

---

## 1. Why Voice?

Screenshots capture what's on screen but miss a huge amount of context:

- **Meetings & calls** — who said what, decisions made, action items committed to
- **Thinking out loud** — the user narrating their intent while coding/browsing
- **Phone/in-person conversations** — context that never touches the screen
- **Voice notes** — quick "note to self" moments

The existing Apple Notes integration already shows the pattern: the wiki gets richer
when it has more signal sources. Voice is the highest-value next source.

---

## 2. Architecture Overview

The design mirrors the existing screenshot pipeline:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Mic Capture  │────▶│  Transcribe  │────▶│  Inbox (.txt) │────▶│  Wiki Loop   │
│  (ffmpeg)     │     │  (Whisper)   │     │              │     │  (smart model)│
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     audio/              voice/              inbox/
     chunks/             transcripts/        voice-*.txt
```

**Three new loops, one new input to the existing wiki loop:**

1. **`micLoop`** — records audio in rolling chunks (like `screenshotLoop` takes periodic screenshots)
2. **`transcribeLoop`** — picks up audio chunks and transcribes them (like `extractLoop` describes screenshots)
3. **Wiki loop** — already handles mixed inputs (screenshots + Apple Notes). Voice transcripts become a third input type, no structural change needed.

---

## 3. Mic Capture (`src/mic.ts`)

### 3.1 Recording Approach

Use **ffmpeg** with macOS AVFoundation to capture from the default microphone.
ffmpeg is already commonly installed (confirmed present at `/opt/homebrew/bin/ffmpeg`)
and handles all the audio driver complexity.

```typescript
// Record a chunk of audio to a WAV file
function recordChunk(outputPath: string, durationSecs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-i", ":0",                    // default audio device
      "-t", String(durationSecs),    // chunk duration
      "-ac", "1",                    // mono
      "-ar", "16000",                // 16kHz (Whisper's native rate)
      "-y",                          // overwrite
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}
```

### 3.2 Chunk Duration & Silence Detection

**Fixed chunks (simple, recommended for v1):**
- Record in **30-second chunks** to `audio/chunks/`
- Each chunk is a small WAV file (~480KB at 16kHz mono 16-bit)
- Simple, predictable, easy to debug

**Silence-based splitting (v2 enhancement):**
- Use ffmpeg's `silencedetect` filter to find natural pauses
- Split on 2+ seconds of silence
- Avoids cutting mid-sentence
- More complex but produces cleaner transcripts

### 3.3 Voice Activity Detection (VAD)

Critical for avoiding wasted transcription on silence. Two approaches:

**A. RMS energy check (simple, no dependencies):**
```typescript
// After recording a chunk, check if it contains speech
async function hasVoiceActivity(wavPath: string): Promise<boolean> {
  // Use ffmpeg to compute mean volume
  const { stderr } = await execFileAsync("ffmpeg", [
    "-i", wavPath,
    "-af", "volumedetect",
    "-f", "null", "-"
  ]);
  // Parse: mean_volume: -30.2 dB
  const match = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  if (!match) return false;
  const meanDb = parseFloat(match[1]);
  return meanDb > -35; // threshold: above -35dB likely has speech
}
```

**B. WebRTC VAD via npm package (more accurate, adds dependency):**
- `@peerjs/webrtc-vad` or similar
- Frame-level detection, very accurate
- Overkill for v1

**Recommendation:** Start with RMS energy check. It's zero-dependency and catches
the 90% case (silent room vs. someone talking). Tune the threshold per-user
via settings.

### 3.4 The micLoop

```typescript
async function micLoop(config: Config, signal: AbortSignal): Promise<void> {
  const chunksDir = join(config.rootDir, "audio", "chunks");
  await mkdir(chunksDir, { recursive: true });

  const CHUNK_DURATION_SECS = 30;

  while (!signal.aborted) {
    const filename = `chunk-${Date.now()}.wav`;
    const chunkPath = join(chunksDir, filename);

    try {
      await recordChunk(chunkPath, CHUNK_DURATION_SECS);

      // Skip silent chunks
      if (!(await hasVoiceActivity(chunkPath))) {
        await unlink(chunkPath).catch(() => {});
        continue;
      }

      console.log(`🎙️ Voice detected — saved ${filename}`);
    } catch (err) {
      console.error(`🎙️ Mic capture failed:`, err);
      await sleep(5000);
    }
  }
}
```

### 3.5 Linux Support

On Linux, replace `-f avfoundation -i ":0"` with:
```
-f pulse -i default    # PulseAudio
-f alsa -i default     # ALSA fallback
```

Detection:
```typescript
function getMicArgs(): string[] {
  if (process.platform === "darwin") return ["-f", "avfoundation", "-i", ":0"];
  // Try PulseAudio first, fall back to ALSA
  try {
    execFileSync("pactl", ["info"], { stdio: "ignore" });
    return ["-f", "pulse", "-i", "default"];
  } catch {
    return ["-f", "alsa", "-i", "default"];
  }
}
```

---

## 4. Transcription (`src/transcribe.ts`)

### 4.1 Option A: OpenAI Whisper API (Recommended for v1)

**Pros:** No local setup, high accuracy, handles accents/noise well, fast
**Cons:** Costs money (~$0.006/min), requires network, audio leaves the machine

```typescript
async function transcribeWhisperAPI(wavPath: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([await readFile(wavPath)]), "audio.wav");
  formData.append("model", "whisper-1");
  formData.append("response_format", "text");
  formData.append("language", "en"); // optional, improves accuracy

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  });

  return (await response.text()).trim();
}
```

**Cost estimate:** At 30-second chunks, only chunks with voice activity get transcribed.
In a typical workday with ~2 hours of actual speaking, that's ~120 minutes × $0.006 = **$0.72/day**.

### 4.2 Option B: Local Whisper via whisper.cpp

**Pros:** Free, private, no network needed
**Cons:** Requires separate install, uses CPU/GPU, slower on older machines

```bash
# Install
brew install whisper-cpp

# Transcribe
whisper-cpp -m /path/to/ggml-base.en.bin -f chunk.wav --output-txt
```

```typescript
async function transcribeWhisperLocal(wavPath: string): Promise<string> {
  const modelPath = join(homedir(), ".whisper", "ggml-base.en.bin");
  const { stdout } = await execFileAsync("whisper-cpp", [
    "-m", modelPath,
    "-f", wavPath,
    "--no-timestamps",
    "--output-txt",
  ]);
  return stdout.trim();
}
```

### 4.3 Option C: macOS SFSpeechRecognizer (Zero-dependency)

**Pros:** Built into macOS, no install, free, private
**Cons:** macOS only, requires a small Swift helper binary, less accurate than Whisper

```swift
// transcribe.swift — compile once, call from Node
import Speech

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = SFSpeechURLRecognitionRequest(url: url)

recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        print(result.bestTranscription.formattedString)
        exit(0)
    }
    if let error = error {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
RunLoop.main.run()
```

```typescript
// Call from Node
async function transcribeMacOS(wavPath: string): Promise<string> {
  const helperPath = join(__dirname, "..", "helpers", "transcribe");
  const { stdout } = await execFileAsync(helperPath, [wavPath]);
  return stdout.trim();
}
```

### 4.4 Recommended Strategy: Configurable Backend

Add to `settings.json`:
```json
{
  "voiceEnabled": true,
  "voiceBackend": "whisper-api",   // "whisper-api" | "whisper-local" | "macos" | "off"
  "voiceChunkSecs": 30,
  "voiceSilenceThresholdDb": -35
}
```

The `transcribeLoop` picks the backend based on settings, with fallback:
1. Try configured backend
2. If it fails, log a warning and disable for the session (same pattern as Apple Notes)

---

## 5. Integration with the Wiki Loop

### 5.1 Transcript Format in Inbox

Transcripts land in `inbox/` as `voice-{timestamp}.txt`, distinct from
`screenshot-{timestamp}.txt`. The wiki loop already processes `.txt` files
from inbox — we just need to handle the `voice-` prefix.

```typescript
// In transcribeLoop, after successful transcription:
const txtFilename = `voice-${Date.now()}.txt`;
const txtPath = join(config.inboxDir, txtFilename);
await writeFile(txtPath, transcript, "utf-8");
```

### 5.2 Changes to wikiLoop

The wiki loop currently collects `screenshot-*.txt` files. Extend it to also
collect `voice-*.txt` files and format them differently in the prompt:

```typescript
// In wikiLoop, alongside the existing screenshot extraction collection:
const voiceTxts = updatedFiles
  .filter(f => f.startsWith("voice-") && f.endsWith(".txt"))
  .sort();

// Build voice context (similar to notesContext)
let voiceContext = "";
if (voiceTxts.length > 0) {
  voiceContext = `${voiceTxts.length} voice transcript(s):\n\n`;
  for (const txtFile of voiceTxts) {
    const text = await readFile(join(config.inboxDir, txtFile), "utf-8");
    const tsMatch = txtFile.match(/voice-(\d+)\./);
    const timestamp = tsMatch ? new Date(parseInt(tsMatch[1], 10)) : new Date();
    voiceContext += `--- [${timestamp.toLocaleTimeString()} — spoken] ---\n${text}\n\n`;
  }
}
```

### 5.3 Changes to agent.ts `sendExtractions`

Add a `voiceContext` parameter alongside `notesContext`:

```typescript
async sendExtractions(
  extractions: Extraction[],
  notesContext?: string,
  voiceContext?: string,
): Promise<string> {
  // ... existing code ...

  if (voiceContext) {
    body += "\n" + voiceContext + "\n";
    body += "These are transcripts of what the user said aloud. " +
      "Capture decisions, commitments, action items, and context. " +
      "Attribute statements to the user unless another speaker is identifiable.\n\n";
  }

  // ... rest of existing code ...
}
```

### 5.4 Prompt Additions

Add to the system prompt (`prompt.md`):

```markdown
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
```

---

## 6. Privacy & Settings

### 6.1 Opt-in, Not Opt-out

Voice capture is **off by default**. The user must explicitly enable it in settings.
This is a higher privacy bar than screenshots (which are also opt-in by running the daemon,
but voice captures other people in the room).

### 6.2 Settings UI Addition

Add a "Voice" fieldset to the settings page in `browser.ts`:

```html
<fieldset>
  <legend>🎙️ Voice capture</legend>
  <p class="desc">Capture ambient audio from your microphone and transcribe it.
    Off by default. Audio chunks are deleted after transcription.</p>
  <div class="field">
    <label>Enable voice capture</label>
    <select name="voiceEnabled">
      <option value="false">Off</option>
      <option value="true">On</option>
    </select>
  </div>
  <div class="field">
    <label>Transcription backend</label>
    <select name="voiceBackend">
      <option value="whisper-api">OpenAI Whisper API ($0.006/min)</option>
      <option value="whisper-local">Local whisper.cpp (free, needs install)</option>
      <option value="macos">macOS built-in (free, less accurate)</option>
    </select>
  </div>
  <div class="field">
    <label>Chunk duration (seconds)</label>
    <input type="number" name="voiceChunkSecs" value="30" min="10" max="120">
  </div>
</fieldset>
```

### 6.3 Audio Retention Policy

- Raw audio chunks are **deleted immediately after transcription**
- Only the text transcript is kept (moved to `processed/` after wiki update)
- No audio is ever sent to the wiki or stored long-term
- This is important for privacy and disk space

### 6.4 Microphone Permission

On macOS, the first ffmpeg capture will trigger a system permission dialog:
*"Terminal (or Node) wants to access the microphone."*

The daemon should detect this gracefully:
```typescript
// If ffmpeg exits with code 1 and stderr mentions "permission",
// log a helpful message and disable voice for the session
if (stderr.includes("Permission") || stderr.includes("not granted")) {
  console.log("🎙️ Microphone permission not granted — voice capture disabled");
  console.log("   Grant permission in System Settings → Privacy & Security → Microphone");
  voiceDisabled = true;
  return;
}
```

---

## 7. New Files

### 7.1 `src/mic.ts`

```
Exports:
  - recordChunk(outputPath, durationSecs): Promise<void>
  - hasVoiceActivity(wavPath): Promise<boolean>
  - getMicInputArgs(): string[]
```

~80 lines. Handles ffmpeg spawning, platform detection, VAD.

### 7.2 `src/transcribe.ts`

```
Exports:
  - transcribe(wavPath, backend): Promise<string>
  - TranscribeBackend = "whisper-api" | "whisper-local" | "macos"
```

~120 lines. Backend selection, API calls, error handling.

### 7.3 Changes to Existing Files

| File | Change |
|------|--------|
| `src/main.ts` | Add `micLoop()` and `transcribeLoop()` to `Promise.all()`. Add voice settings loading. |
| `src/main.ts` | `wikiLoop` collects `voice-*.txt` alongside `screenshot-*.txt` |
| `src/agent.ts` | `sendExtractions()` gains `voiceContext` parameter |
| `src/settings.ts` | Add `voiceEnabled`, `voiceBackend`, `voiceChunkSecs`, `voiceSilenceThresholdDb` fields |
| `src/browser.ts` | Add voice settings fieldset to settings page |
| `src/prompt.ts` | Add voice transcript guidance to `DEFAULT_PROMPT` |
| `package.json` | No new dependencies for v1 (ffmpeg is external, fetch is built-in) |

---

## 8. The Loops in main.ts

After adding voice, `main()` runs five concurrent loops:

```typescript
await Promise.all([
  extractLoop(config, agent, signal),       // screenshot → text
  transcribeLoop(config, signal),            // audio → text (NEW)
  wikiLoop(config, agent, signal),           // text → wiki
  sleep(2000).then(() => screenshotLoop(config, signal)),
  sleep(2000).then(() => micLoop(config, signal)),  // NEW
]);
```

The `transcribeLoop` is analogous to `extractLoop`:

```typescript
async function transcribeLoop(config: Config, signal: AbortSignal): Promise<void> {
  if (!config.voiceEnabled) return;

  const chunksDir = join(config.rootDir, "audio", "chunks");
  const processedAudioDir = join(config.rootDir, "audio", "processed");
  await mkdir(chunksDir, { recursive: true });
  await mkdir(processedAudioDir, { recursive: true });

  while (!signal.aborted) {
    const files = await readdir(chunksDir).catch(() => []);
    const wavs = files.filter(f => f.endsWith(".wav")).sort();

    if (wavs.length === 0) {
      await sleep(3000);
      continue;
    }

    for (const wav of wavs) {
      if (signal.aborted) break;
      const wavPath = join(chunksDir, wav);

      try {
        console.log(`🎙️ Transcribing: ${wav}`);
        const text = await transcribe(wavPath, config.voiceBackend);

        if (text && text.length > 10) {
          // Write transcript to inbox for wiki loop to pick up
          const tsMatch = wav.match(/chunk-(\d+)\./);
          const timestamp = tsMatch ? tsMatch[1] : String(Date.now());
          const txtPath = join(config.inboxDir, `voice-${timestamp}.txt`);
          await writeFile(txtPath, text, "utf-8");
          console.log(`✅ Transcribed: ${text.substring(0, 80)}…`);
        }

        // Delete audio after transcription (privacy)
        await unlink(wavPath).catch(() => {});
      } catch (err) {
        console.error(`❌ Transcription failed:`, err);
        // Move failed audio to processed to avoid retry loop
        await rename(wavPath, join(processedAudioDir, wav)).catch(() =>
          unlink(wavPath).catch(() => {})
        );
      }
    }
  }
}
```

---

## 9. Cost & Resource Estimates

### Whisper API costs
| Scenario | Speaking time/day | Cost/day | Cost/month |
|----------|-------------------|----------|------------|
| Light (solo coding) | ~15 min | $0.09 | $2.70 |
| Medium (some meetings) | ~1 hour | $0.36 | $10.80 |
| Heavy (lots of meetings) | ~3 hours | $1.08 | $32.40 |

### Disk usage
- 30-sec WAV at 16kHz mono: ~960KB
- Deleted after transcription, so steady-state is just a few MB in `audio/chunks/`
- Transcripts in inbox: ~1-2KB each, moved to processed after wiki update

### CPU usage
- ffmpeg recording: negligible (<1% CPU)
- Local whisper.cpp: ~10-30% CPU per transcription (base model), ~5 seconds per 30-second chunk
- Whisper API: negligible (network only)

---

## 10. Implementation Plan

### Phase 1: Basic mic capture + Whisper API (smallest useful thing)
1. Add `src/mic.ts` — ffmpeg recording + RMS-based VAD
2. Add `src/transcribe.ts` — Whisper API backend only
3. Wire `micLoop` + `transcribeLoop` into `main.ts`
4. Extend `wikiLoop` to collect `voice-*.txt` files
5. Add `voiceEnabled` to settings (off by default)
6. Add voice settings to browser UI

**Estimated effort:** ~200 lines of new code, ~50 lines of changes to existing files.

### Phase 2: Local transcription + polish
1. Add whisper.cpp backend to `transcribe.ts`
2. Add macOS SFSpeechRecognizer backend (Swift helper)
3. Silence-based chunk splitting (smarter than fixed 30s)
4. Speaker diarization hint in prompt ("multiple speakers detected")

### Phase 3: Advanced features
1. Keyword/wake-word detection ("Hey Goose, remember that...")
2. Real-time streaming transcription (instead of chunk-based)
3. Meeting detection (calendar integration → auto-enable during meetings)
4. Speaker identification (voice fingerprinting)

---

## 11. Open Questions

1. **Should voice transcripts go through the fast model first?**
   Screenshots go through a fast model for extraction, then the smart model for wiki updates.
   Voice transcripts are already text — they could skip the fast model entirely and go
   straight to the wiki loop. But a fast-model pass could clean up transcription errors,
   identify speakers, and extract structure. Worth testing both approaches.

2. **Chunk duration tradeoff:**
   Shorter chunks (15s) = faster feedback, more API calls, more mid-sentence cuts.
   Longer chunks (60s) = better context per transcription, fewer calls, higher latency.
   30s is a reasonable default. Could be adaptive based on voice activity density.

3. **Multiple microphones:**
   Some users have USB mics, AirPods, etc. Should we let them pick the input device?
   For v1, default device is fine. For v2, add a device selector in settings.

4. **Meeting mode:**
   Should there be an explicit "I'm in a meeting" toggle that increases capture
   frequency and adds meeting-specific prompting? Could integrate with calendar
   to auto-detect.

5. **Overlap with screen audio:**
   If the user is on a Zoom/Meet call, the mic captures their side but not the
   remote participants (unless using a loopback device). Should we also capture
   system audio? This is technically possible with BlackHole/Soundflower but
   adds significant complexity.

---

## 12. Comparison with Existing Patterns

| Aspect | Screenshots | Apple Notes | Voice (proposed) |
|--------|-------------|-------------|------------------|
| Capture | `screencapture` CLI | AppleScript | `ffmpeg` CLI |
| Storage | PNG → inbox/ | In Notes.app | WAV → audio/chunks/ |
| Extraction | Fast model (vision) | Direct text read | Whisper transcription |
| Output | `screenshot-*.txt` in inbox | Inline in wiki prompt | `voice-*.txt` in inbox |
| Wiki integration | Via `sendExtractions()` | Via `notesContext` param | Via `voiceContext` param |
| State tracking | File presence in inbox | `notes-state.json` | File presence in chunks/ |
| Privacy | Screenshots stay local | Notes stay local | Audio deleted after transcription |
| Platform | macOS + Linux | macOS only | macOS + Linux |
| Default | On | On (macOS) | **Off** |

The voice feature follows the exact same pipeline pattern. The codebase is
well-structured for this — each input source has its own capture loop and
extraction step, and they all converge in the wiki loop.

---

## 13. Directory Layout (Updated)

```
~/perception/
├── prompt.md
├── lint.md
├── settings.json          # + voiceEnabled, voiceBackend, voiceChunkSecs
├── audio/                 # NEW
│   ├── chunks/            # Temporary WAV files (deleted after transcription)
│   └── processed/         # Failed transcriptions (for debugging)
├── wiki/
│   ├── log.md
│   ├── todos.md
│   ├── dates/
│   ├── persons/
│   └── projects/
├── inbox/
│   ├── screenshot-*.png
│   ├── screenshot-*.txt
│   └── voice-*.txt        # NEW — transcripts ready for wiki loop
└── processed/
```
