import { execFile, execFileSync } from "node:child_process";
import { readFile, mkdir, readdir, unlink, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMPARE_WIDTH = 1024;
const DIFF_THRESHOLD = 0.02;

export interface Screenshot {
  path: string;
  timestamp: Date;
  base64: string;
  mimeType: string;
  windowInfo?: WindowInfo;
}

export interface WindowInfo {
  windowId: number;
  app: string;
  title: string;
  url: string;
}

// ── Window info ──

/**
 * Get the frontmost window's CGWindowID, app name, and title using Swift.
 * Falls back to osascript for the app name if Swift fails.
 */
export function getFrontWindow(): WindowInfo {
  try {
    const out = execFileSync("swift", ["-e", `
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
`], { encoding: "utf-8", timeout: 5000 }).trim();

    const [idStr, app, ...titleParts] = out.split("|");
    const windowId = parseInt(idStr ?? "0", 10);
    const title = titleParts.join("|"); // title may contain |
    const url = getBrowserUrl(app ?? "");
    return { windowId, app: app ?? "", title: title ?? "", url };
  } catch {
    // Fallback: just get the app name
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

function getBrowserUrl(app: string): string {
  const scripts: Record<string, string> = {
    "Google Chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
    Safari: 'tell application "Safari" to get URL of front document',
    Arc: 'tell application "Arc" to get URL of active tab of front window',
    Firefox: 'tell application "Firefox" to get URL of active tab of front window',
  };
  const script = scripts[app];
  if (!script) return "";
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

// ── Capture ──

/**
 * Capture a specific window by CGWindowID, or full screen if windowId is 0.
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

/**
 * Write window metadata alongside a screenshot PNG.
 */
export async function writeWindowInfo(pngPath: string, info: WindowInfo): Promise<void> {
  const jsonPath = pngPath.replace(/\.png$/, ".json");
  await writeFile(jsonPath, JSON.stringify(info), "utf-8");
}

/**
 * Read window metadata for a screenshot, if it exists.
 */
export async function readWindowInfo(pngPath: string): Promise<WindowInfo | null> {
  try {
    const jsonPath = pngPath.replace(/\.png$/, ".json");
    const data = await readFile(jsonPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── Change detection ──

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

async function bmpDiff(pathA: string, pathB: string): Promise<number> {
  const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
  if (a.length !== b.length) return 1.0;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff / a.length;
}

export async function hasChangedEnough(
  currentPng: string,
  baseBmpPath: string,
): Promise<{ changed: boolean; diff: number }> {
  const currentBmp = await toBmp(currentPng);
  try {
    const diff = await bmpDiff(baseBmpPath, currentBmp);
    return { changed: diff >= DIFF_THRESHOLD, diff };
  } finally {
    await unlink(currentBmp).catch(() => {});
  }
}

export async function createBaseBmp(pngPath: string): Promise<string> {
  return toBmp(pngPath);
}

// ── JPEG conversion ──

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

// ── Housekeeping ──

export async function flushInbox(dir: string, processedDir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  await mkdir(processedDir, { recursive: true });

  const files = await readdir(dir);
  const screenshots = files.filter((f) => f.startsWith("screenshot-"));
  for (const file of screenshots) {
    await rename(join(dir, file), join(processedDir, file));
  }
  return screenshots.length;
}

export async function countPending(dir: string): Promise<number> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.startsWith("screenshot-") && f.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

export async function cleanupProcessed(processedDir: string, keepLast: number = 50): Promise<void> {
  try {
    const files = await readdir(processedDir);
    const imgs = files.filter((f) => f.startsWith("screenshot-")).sort();
    const toRemove = imgs.slice(0, Math.max(0, imgs.length - keepLast));
    for (const file of toRemove) {
      await unlink(join(processedDir, file));
    }
  } catch {
    // dir might not exist yet
  }
}
