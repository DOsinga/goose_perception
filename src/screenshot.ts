import { execFile, execFileSync } from "node:child_process";
import { readFile, mkdir, readdir, unlink, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const COMPARE_WIDTH = 1024;
const DIFF_THRESHOLD = 0.02; // 2% of bytes must differ to count as a change

export interface WindowInfo {
  windowId: number;
  app: string;
  title: string;
  url: string;
}

export interface Screenshot {
  path: string;
  timestamp: Date;
  base64: string;
  mimeType: string;
  windowInfo?: WindowInfo;
}

// ── Window info ──

const FRONTWINDOW_SWIFT = `
import CoreGraphics
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
        if (w["kCGWindowLayer"] as? Int ?? 999) == 0 {
            let id = w["kCGWindowNumber"] as? Int ?? 0
            let app = w["kCGWindowOwnerName"] as? String ?? ""
            let title = w["kCGWindowName"] as? String ?? ""
            print("\\(id)|\\(app)|\\(title)")
            break
        }
    }
}
`;

let frontwindowBin: string | null = null;

function ensureFrontwindowBin(): string {
  if (frontwindowBin && existsSync(frontwindowBin)) return frontwindowBin;
  const binPath = join(tmpdir(), "goose-perception-frontwindow");
  const srcPath = binPath + ".swift";
  try {
    execFileSync("sh", ["-c", `cat > '${srcPath}' << 'SWIFT'\n${FRONTWINDOW_SWIFT}\nSWIFT`]);
    execFileSync("swiftc", ["-O", srcPath, "-o", binPath], { timeout: 30000 });
    frontwindowBin = binPath;
  } catch {
    frontwindowBin = null;
  }
  return frontwindowBin ?? "";
}

export function getFrontWindow(): WindowInfo {
  if (process.platform !== "darwin") {
    return { windowId: 0, app: "", title: "", url: "" };
  }
  try {
    const bin = ensureFrontwindowBin();
    if (!bin) throw new Error("no frontwindow binary");
    const out = execFileSync(bin, { encoding: "utf-8", timeout: 2000 }).trim();
    const [idStr, app, ...titleParts] = out.split("|");
    const windowId = parseInt(idStr ?? "0", 10);
    const title = titleParts.join("|");
    return { windowId, app: app ?? "", title: title ?? "", url: "" };
  } catch {
    try {
      const app = execFileSync("osascript", ["-e",
        'tell application "System Events" to name of first application process whose frontmost is true',
      ], { encoding: "utf-8", timeout: 3000 }).trim();
      return { windowId: 0, app, title: "", url: "" };
    } catch {
      return { windowId: 0, app: "", title: "", url: "" };
    }
  }
}

export async function writeWindowInfo(pngPath: string, info: WindowInfo): Promise<void> {
  const jsonPath = pngPath.replace(/\.png$/, ".json");
  await writeFile(jsonPath, JSON.stringify(info), "utf-8");
}

export async function readWindowInfo(pngPath: string): Promise<WindowInfo | null> {
  try {
    const jsonPath = pngPath.replace(/\.png$/, ".json");
    const data = await readFile(jsonPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── Capture ──

/**
 * Take a screenshot and save as full-resolution PNG to the inbox.
 */
export async function takeScreenshot(dir: string, windowId?: number): Promise<string> {
  await mkdir(dir, { recursive: true });

  const ts = Date.now();
  const filepath = join(dir, `screenshot-${ts}.png`);
  const tmpPng = join(dir, `tmp_capture_${ts}.png`);

  await new Promise<void>((resolve, reject) => {
    if (process.platform === "darwin") {
      const args = windowId
        ? ["-x", "-o", "-l", String(windowId), tmpPng]
        : ["-x", "-m", tmpPng];
      execFile("screencapture", args, (err) => {
        if (err) reject(new Error(`screencapture failed: ${err.message}`));
        else resolve();
      });
    } else if (process.platform === "linux") {
      execFile("gnome-screenshot", ["-f", tmpPng], (err) => {
        if (err) {
          execFile("scrot", [tmpPng], (err2) => {
            if (err2) reject(new Error(`screenshot failed: no tool available`));
            else resolve();
          });
        } else {
          resolve();
        }
      });
    } else {
      reject(new Error(`unsupported platform: ${process.platform}`));
    }
  });

  await rename(tmpPng, filepath);
  return filepath;
}

// ── Change detection ──

/**
 * Convert a PNG to a 1024-wide BMP for byte comparison.
 * Returns the path to the temp BMP.
 */
async function toBmp(pngPath: string): Promise<string> {
  const bmpPath = pngPath + ".cmp.bmp";
  await new Promise<void>((resolve, reject) => {
    if (process.platform === "darwin") {
      execFile("sips", [
        "--resampleWidth", String(COMPARE_WIDTH),
        "-s", "format", "bmp",
        pngPath,
        "--out", bmpPath,
      ], (err) => {
        if (err) reject(new Error(`sips bmp convert failed: ${err.message}`));
        else resolve();
      });
    } else {
      execFile("convert", [
        pngPath, "-resize", `${COMPARE_WIDTH}x>`, "bmp:" + bmpPath,
      ], (err) => {
        if (err) reject(new Error(`convert bmp failed: ${err.message}`));
        else resolve();
      });
    }
  });
  return bmpPath;
}

/**
 * Compare two BMP files byte-by-byte and return the fraction of differing bytes.
 */
async function bmpDiff(pathA: string, pathB: string): Promise<number> {
  const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
  if (a.length !== b.length) return 1.0; // different dimensions = total change
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff / a.length;
}

/**
 * Determine if a screenshot has changed enough from the base.
 * Returns the diff fraction (0.0 = identical, 1.0 = completely different).
 */
export async function hasChangedEnough(currentPng: string, baseBmpPath: string): Promise<{ changed: boolean; diff: number }> {
  const currentBmp = await toBmp(currentPng);
  try {
    const diff = await bmpDiff(baseBmpPath, currentBmp);
    return { changed: diff >= DIFF_THRESHOLD, diff };
  } finally {
    await unlink(currentBmp).catch(() => {});
  }
}

/**
 * Create a BMP thumbnail for use as comparison base.
 * Caller owns the returned file and must clean it up.
 */
export async function createBaseBmp(pngPath: string): Promise<string> {
  return toBmp(pngPath);
}

// ── Collection ──

/**
 * Convert a PNG to JPEG for sending to the model.
 * Returns the base64-encoded JPEG.
 */
export async function pngToJpegBase64(pngPath: string): Promise<string> {
  const jpgPath = pngPath + ".send.jpg";
  try {
    await new Promise<void>((resolve, reject) => {
      if (process.platform === "darwin") {
        execFile("sips", [
          "--resampleWidth", "1280",
          "-s", "format", "jpeg",
          "-s", "formatOptions", "60",
          pngPath,
          "--out", jpgPath,
        ], (err) => {
          if (err) reject(new Error(`sips jpeg convert failed: ${err.message}`));
          else resolve();
        });
      } else {
        execFile("convert", [
          pngPath, "-resize", "1280x>", "-quality", "60", jpgPath,
        ], (err) => {
          if (err) reject(new Error(`convert jpeg failed: ${err.message}`));
          else resolve();
        });
      }
    });
    const data = await readFile(jpgPath);
    return data.toString("base64");
  } finally {
    await unlink(jpgPath).catch(() => {});
  }
}

/**
 * Collect screenshots from the inbox. Samples at most 3 (first, middle, last)
 * and converts to JPEG for sending. All files are moved to processed.
 */
export async function collectScreenshots(inboxDir: string, processedDir: string): Promise<Screenshot[]> {
  await mkdir(processedDir, { recursive: true });

  const files = await readdir(inboxDir);
  const all = files
    .filter((f) => f.startsWith("screenshot-") && f.endsWith(".png"))
    .sort();

  // Pick first, middle, last
  const sampled = new Set<string>();
  if (all.length > 0) sampled.add(all[0]!);
  if (all.length > 2) sampled.add(all[Math.floor(all.length / 2)]!);
  if (all.length > 1) sampled.add(all[all.length - 1]!);

  const results: Screenshot[] = [];

  for (const file of all) {
    const filepath = join(inboxDir, file);

    if (sampled.has(file)) {
      const base64 = await pngToJpegBase64(filepath);
      const tsMatch = file.match(/screenshot-(\d+)\./);
      const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();
      results.push({ path: filepath, timestamp, base64, mimeType: "image/jpeg" });
    }

    await rename(filepath, join(processedDir, file));
  }

  return results;
}

/**
 * Flush the inbox — move everything to processed without reading.
 */
export async function flushInbox(inboxDir: string, processedDir: string): Promise<number> {
  await mkdir(inboxDir, { recursive: true });
  await mkdir(processedDir, { recursive: true });

  const files = await readdir(inboxDir);
  const screenshots = files.filter((f) => f.startsWith("screenshot-"));
  for (const file of screenshots) {
    await rename(join(inboxDir, file), join(processedDir, file));
  }
  return screenshots.length;
}

/**
 * Count pending screenshots in inbox.
 */
export async function countPending(inboxDir: string): Promise<number> {
  try {
    const files = await readdir(inboxDir);
    return files.filter((f) => f.startsWith("screenshot-") && f.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

/**
 * Clean up old processed screenshots (keep last N).
 */
export async function cleanupProcessed(processedDir: string, keepLast: number = 50): Promise<void> {
  try {
    const files = await readdir(processedDir);
    const imgs = files.filter((f) => f.startsWith("screenshot-")).sort();
    const toRemove = imgs.slice(0, Math.max(0, imgs.length - keepLast));
    for (const file of toRemove) {
      await unlink(join(processedDir, file));
    }
  } catch {
    // processed dir might not exist yet
  }
}
