import { execFile } from "node:child_process";
import { readFile, mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscribeBackend = "whisper-api" | "whisper-local" | "macos";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command and capture stdout / stderr. */
function exec(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            Object.assign(err, {
              stdout: stdout?.toString() ?? "",
              stderr: stderr?.toString() ?? "",
            }),
          );
        } else {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
          });
        }
      },
    );
  });
}

/** Check whether a binary is reachable on $PATH. */
async function whichExists(bin: string): Promise<boolean> {
  try {
    await exec("/usr/bin/which", [bin], 5_000);
    return true;
  } catch {
    return false;
  }
}

/** Check whether a file exists. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Swift helper source for the macOS backend
// ---------------------------------------------------------------------------

const SWIFT_SOURCE = `
import Foundation
import Speech

let semaphore = DispatchSemaphore(value: 0)

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: transcribe-macos <path-to-wav>\\n", stderr)
    exit(1)
}

let filePath = CommandLine.arguments[1]
let fileURL  = URL(fileURLWithPath: filePath)

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition not authorized (status \\(status.rawValue))\\n", stderr)
        exit(2)
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
          recognizer.isAvailable else {
        fputs("SFSpeechRecognizer unavailable\\n", stderr)
        exit(3)
    }

    let request = SFSpeechURLRecognitionRequest(url: fileURL)
    request.shouldReportPartialResults = false

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            fputs("Recognition error: \\(error.localizedDescription)\\n", stderr)
            exit(4)
        }
        if let result = result, result.isFinal {
            print(result.bestTranscription.formattedString)
            semaphore.signal()
        }
    }
}

semaphore.wait()
`;

const HELPERS_DIR = path.join(os.homedir(), "perception", "helpers");
const COMPILED_BIN = path.join(HELPERS_DIR, "transcribe-macos");
const SWIFT_SRC_PATH = path.join(HELPERS_DIR, "transcribe-macos.swift");

// ---------------------------------------------------------------------------
// Backend: whisper-api
// ---------------------------------------------------------------------------

/**
 * Validate that a file looks like a real WAV with actual audio data.
 * Checks for minimum size, RIFF header, and WAVE format marker.
 * Throws a descriptive error if the file is invalid.
 */
export async function validateWav(wavPath: string): Promise<Buffer> {
  const fileBuffer = await readFile(wavPath);

  if (fileBuffer.length === 0) {
    throw new Error(`WAV file is empty (0 bytes): ${wavPath}`);
  }

  // A valid WAV needs at least a 44-byte header + some audio data
  if (fileBuffer.length < 128) {
    throw new Error(
      `WAV file too small (${fileBuffer.length} bytes) — likely truncated: ${wavPath}`,
    );
  }

  // Check RIFF header magic bytes
  const header = fileBuffer.subarray(0, 12).toString("ascii");
  if (!header.startsWith("RIFF") || !header.includes("WAVE")) {
    throw new Error(
      `Not a valid WAV file (bad header: ${JSON.stringify(header.slice(0, 12))}): ${wavPath}`,
    );
  }

  return fileBuffer;
}

async function transcribeWhisperApi(wavPath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "whisper-api backend requires the OPENAI_API_KEY environment variable to be set.",
    );
  }

  const fileBuffer = await validateWav(wavPath);
  const fileName = path.basename(wavPath);

  const form = new FormData();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form.append("file", new Blob([fileBuffer] as any, { type: "audio/wav" }), fileName);
  form.append("model", "whisper-1");
  form.append("response_format", "text");
  form.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `whisper-api request failed (${res.status} ${res.statusText}): ${body}`,
    );
  }

  const text = await res.text();
  return text.trim();
}

// ---------------------------------------------------------------------------
// Backend: whisper-local
// ---------------------------------------------------------------------------

async function transcribeWhisperLocal(wavPath: string): Promise<string> {
  // Validate the file before shelling out to whisper
  await validateWav(wavPath);

  // Determine which CLI to use -------------------------------------------------
  const hasWhisperCpp = await whichExists("whisper-cpp");
  const hasWhisper = await whichExists("whisper");

  if (!hasWhisperCpp && !hasWhisper) {
    throw new Error(
      "whisper-local backend requires either 'whisper-cpp' or 'whisper' (Python) to be installed and on PATH.",
    );
  }

  const useWhisperCpp = hasWhisperCpp;

  // Check for a local model file ------------------------------------------------
  const defaultModelPath = path.join(
    os.homedir(),
    ".whisper",
    "ggml-base.en.bin",
  );
  const hasModel = await fileExists(defaultModelPath);

  // Build args -------------------------------------------------------------------
  let cmd: string;
  let args: string[];

  if (useWhisperCpp) {
    cmd = "whisper-cpp";
    args = ["--output-txt", "--no-timestamps"];
    if (hasModel) {
      args.push("--model", defaultModelPath);
    }
    args.push(wavPath);
  } else {
    cmd = "whisper";
    args = [wavPath, "--language", "en", "--output_format", "txt"];
    if (hasModel) {
      args.push("--model", "base.en");
    }
  }

  // Execute ----------------------------------------------------------------------
  let stdout: string;
  try {
    const result = await exec(cmd, args);
    stdout = result.stdout;
  } catch (err: any) {
    const stderr = err?.stderr ?? "";
    throw new Error(
      `whisper-local (${cmd}) failed: ${err?.message ?? err}\nstderr: ${stderr}`,
    );
  }

  // Parse result -----------------------------------------------------------------
  // whisper-cpp prints lines like "[00:00:00.000 --> 00:00:02.000]  Hello world"
  // The Python whisper CLI prints plain text to stdout when format is txt.
  const lines = stdout
    .split("\n")
    .map((l) => l.replace(/^\[.*?\]\s*/, "").trim())
    .filter(Boolean);

  return lines.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Backend: macos (SFSpeechRecognizer via compiled Swift helper)
// ---------------------------------------------------------------------------

async function ensureMacOSHelper(): Promise<string> {
  if (await fileExists(COMPILED_BIN)) {
    return COMPILED_BIN;
  }

  // Make sure the helpers directory exists
  await mkdir(HELPERS_DIR, { recursive: true });

  // Write the Swift source
  await writeFile(SWIFT_SRC_PATH, SWIFT_SOURCE, "utf-8");

  // Compile
  try {
    await exec("/usr/bin/swiftc", [
      "-O",
      "-o",
      COMPILED_BIN,
      SWIFT_SRC_PATH,
      "-framework",
      "Speech",
    ]);
  } catch (err: any) {
    throw new Error(
      `Failed to compile macOS transcription helper:\n${err?.stderr ?? err?.message ?? err}`,
    );
  }

  return COMPILED_BIN;
}

async function transcribeMacOS(wavPath: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The 'macos' transcription backend is only available on macOS.");
  }

  // Validate the file before shelling out to the Swift helper
  await validateWav(wavPath);

  const bin = await ensureMacOSHelper();

  let stdout: string;
  try {
    const result = await exec(bin, [wavPath], 180_000);
    stdout = result.stdout;
  } catch (err: any) {
    const stderr = err?.stderr ?? "";
    throw new Error(
      `macOS transcription helper failed: ${err?.message ?? err}\nstderr: ${stderr}`,
    );
  }

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a given transcription backend is available on this system.
 */
export async function checkBackendAvailable(
  backend: TranscribeBackend,
): Promise<boolean> {
  switch (backend) {
    case "whisper-api":
      return typeof process.env.OPENAI_API_KEY === "string" &&
        process.env.OPENAI_API_KEY.length > 0;

    case "whisper-local":
      return (await whichExists("whisper-cpp")) || (await whichExists("whisper"));

    case "macos":
      if (process.platform !== "darwin") return false;
      // Check that swiftc is available (needed to compile the helper on first run)
      return fileExists("/usr/bin/swiftc");

    default: {
      const _exhaustive: never = backend;
      return false;
    }
  }
}

/**
 * Transcribe a WAV audio file to text using the specified backend.
 *
 * @param wavPath  - Absolute or relative path to a .wav file.
 * @param backend  - Which transcription engine to use.
 * @returns The transcribed text (trimmed), or an empty string if nothing was recognised.
 */
export async function transcribe(
  wavPath: string,
  backend: TranscribeBackend,
): Promise<string> {
  // Validate the file exists before doing anything expensive
  if (!(await fileExists(wavPath))) {
    throw new Error(`Audio file not found: ${wavPath}`);
  }

  let result: string;

  switch (backend) {
    case "whisper-api":
      result = await transcribeWhisperApi(wavPath);
      break;

    case "whisper-local":
      result = await transcribeWhisperLocal(wavPath);
      break;

    case "macos":
      result = await transcribeMacOS(wavPath);
      break;

    default: {
      const _exhaustive: never = backend;
      throw new Error(`Unknown transcription backend: ${backend}`);
    }
  }

  return result;
}
