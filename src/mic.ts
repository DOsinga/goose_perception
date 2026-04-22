import { execFile, spawn } from "node:child_process";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// ── Constants ──

/** Default RMS silence threshold in dB. Anything below this is "silence". */
const DEFAULT_SILENCE_THRESHOLD_DB = -35;

/** WAV format tuned for Whisper: mono, 16 kHz, signed 16-bit little-endian. */
const WAV_CODEC_ARGS = [
  "-ac", "1",
  "-ar", "16000",
  "-sample_fmt", "s16",
  "-c:a", "pcm_s16le",
];

// ── Platform mic input args ──

/**
 * Return the ffmpeg input arguments for the default microphone on the
 * current platform.
 *
 * - macOS: AVFoundation, audio-only device `:0`
 * - Linux: PulseAudio `default` (caller should fall back to ALSA via
 *   {@link getLinuxMicInputArgs} if this fails)
 */
export function getMicInputArgs(): string[] {
  if (process.platform === "darwin") {
    return ["-f", "avfoundation", "-i", ":0"];
  }
  // Linux — prefer PulseAudio; ALSA fallback handled in helpers below.
  return ["-f", "pulse", "-i", "default"];
}

/** ALSA fallback args for Linux. */
function getAlsaInputArgs(): string[] {
  return ["-f", "alsa", "-i", "default"];
}

// ── Helpers ──

/** Run ffmpeg and resolve with combined stderr (ffmpeg logs to stderr). */
/** Detect genuine macOS microphone permission denials in ffmpeg stderr. */
const PERMISSION_DENIED_RE = /not grant|permission denied|not authorized/i;

function runFfmpeg(args: string[], timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "ffmpeg",
      ["-hide_banner", "-nostdin", ...args],
      { timeout: timeoutMs ?? 0 },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          // Surface macOS permission errors clearly.
          if (
            process.platform === "darwin" &&
            PERMISSION_DENIED_RE.test(msg)
          ) {
            return reject(
              new Error(
                `Microphone permission denied. Grant Terminal / your app ` +
                  `access in System Settings → Privacy & Security → Microphone.\n` +
                  `ffmpeg stderr: ${msg}`,
              ),
            );
          }
          return reject(new Error(`ffmpeg failed: ${msg}`));
        }
        resolve(stderr ?? "");
      },
    );

    // Safety: kill on unhandled close without callback firing.
    proc.on("error", reject);
  });
}

/**
 * Spawn ffmpeg for recording with a fixed duration. Uses spawn so we can
 * rely on ffmpeg's own `-t` flag to stop, and we get streaming stderr for
 * diagnostics.
 */
function spawnRecord(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-nostdin", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));

    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code !== 0) {
        if (
          process.platform === "darwin" &&
          PERMISSION_DENIED_RE.test(stderr)
        ) {
          return reject(
            new Error(
              `Microphone permission denied. Grant Terminal / your app ` +
                `access in System Settings → Privacy & Security → Microphone.\n` +
                `ffmpeg stderr: ${stderr.trim()}`,
            ),
          );
        }
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      }
      resolve(stderr);
    });

    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)),
    );
  });
}

// ── Public API ──

/**
 * Record an audio chunk from the default microphone and write it as a
 * mono 16 kHz 16-bit WAV file (optimal for Whisper).
 *
 * On Linux, if PulseAudio capture fails the function automatically
 * retries with ALSA.
 *
 * @param outputPath  Destination `.wav` path (parent dirs created automatically).
 * @param durationSecs  How many seconds to record.
 */
export async function recordChunk(
  outputPath: string,
  durationSecs: number,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  // Write to a temp file first, then atomically rename.
  // This prevents the transcription loop from picking up a half-written WAV.
  // Use a .recording.wav extension so ffmpeg can detect the output format.
  const tmpPath = outputPath.replace(/\.wav$/, ".recording.wav");

  const buildArgs = (inputArgs: string[]) => [
    ...inputArgs,
    "-t", String(durationSecs),
    ...WAV_CODEC_ARGS,
    "-y", tmpPath,
  ];

  try {
    await spawnRecord(buildArgs(getMicInputArgs()));
  } catch (err) {
    // On Linux, fall back from PulseAudio → ALSA.
    if (process.platform === "linux") {
      await spawnRecord(buildArgs(getAlsaInputArgs()));
      await rename(tmpPath, outputPath);
      return;
    }
    // Clean up partial temp file on failure
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  await rename(tmpPath, outputPath);
}

/**
 * Analyse a WAV file for voice activity using ffmpeg's `volumedetect`
 * filter. Returns `true` when the mean volume exceeds the threshold
 * (i.e. the audio is louder than silence).
 *
 * @param wavPath       Path to the WAV file to analyse.
 * @param thresholdDb   Maximum mean dB to still count as silence
 *                      (default {@link DEFAULT_SILENCE_THRESHOLD_DB}).
 */
export async function hasVoiceActivity(
  wavPath: string,
  thresholdDb: number = DEFAULT_SILENCE_THRESHOLD_DB,
): Promise<boolean> {
  // Ensure the file exists before shelling out.
  await access(wavPath);

  const stderr = await runFfmpeg([
    "-i", wavPath,
    "-af", "volumedetect",
    "-f", "null",
    "-",
  ]);

  // ffmpeg volumedetect prints e.g.  mean_volume: -28.3 dB
  const match = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  if (!match) {
    // Could not parse — treat as no voice to avoid false positives.
    return false;
  }

  const meanDb = parseFloat(match[1]);
  // meanDb is negative; a *louder* signal is closer to 0.
  // Voice is present when the mean volume is above (less negative than)
  // the silence threshold.
  return meanDb > thresholdDb;
}

/**
 * Quick probe to check whether ffmpeg can open the microphone.
 * Records a tiny 0.1 s snippet to a temp file (WAV can't write to /dev/null
 * because it needs to seek back to write the header).
 *
 * On Linux, returns `true` if either PulseAudio or ALSA succeeds.
 */
export async function checkMicAvailable(): Promise<boolean> {
  const probePath = join(tmpdir(), `mic-probe-${Date.now()}.wav`);

  const probe = async (inputArgs: string[]) => {
    try {
      await runFfmpeg(
        [...inputArgs, "-t", "0.1", ...WAV_CODEC_ARGS, "-y", probePath],
        5_000, // 5 s timeout — don't hang forever
      );
    } finally {
      await unlink(probePath).catch(() => {});
    }
  };

  try {
    await probe(getMicInputArgs());
    return true;
  } catch {
    // Linux PulseAudio may be absent; try ALSA.
    if (process.platform === "linux") {
      try {
        await probe(getAlsaInputArgs());
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
