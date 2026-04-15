import { execFile } from "node:child_process";
import { readFile, mkdir, readdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";

const RESIZE_WIDTH = 1280;
const JPEG_QUALITY = 60;

export interface Screenshot {
  path: string;
  timestamp: Date;
  base64: string;
}

/**
 * Take a screenshot, resize it, and save as JPEG to the inbox directory.
 *
 * macOS: screencapture → sips to resize + convert to JPEG
 * Linux: gnome-screenshot/scrot → convert (ImageMagick) to resize + JPEG
 */
export async function takeScreenshot(inboxDir: string): Promise<string> {
  await mkdir(inboxDir, { recursive: true });

  const ts = Date.now();
  const filepath = join(inboxDir, `screenshot-${ts}.jpg`);
  const tmpPng = join(inboxDir, `tmp_capture_${ts}.png`);
  const tmpJpg = join(inboxDir, `tmp_screenshot_${ts}.jpg`);

  const platform = process.platform;

  // Step 1: capture full-resolution PNG
  await new Promise<void>((resolve, reject) => {
    if (platform === "darwin") {
      execFile("screencapture", ["-x", "-m", tmpPng], (err) => {
        if (err) reject(new Error(`screencapture failed: ${err.message}`));
        else resolve();
      });
    } else if (platform === "linux") {
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
      reject(new Error(`unsupported platform: ${platform}`));
    }
  });

  // Step 2: resize and convert to JPEG
  await new Promise<void>((resolve, reject) => {
    if (platform === "darwin") {
      // sips can resize and convert in one pass
      execFile("sips", [
        "--resampleWidth", String(RESIZE_WIDTH),
        "--setProperty", "format", "jpeg",
        "--setProperty", "formatOptions", String(JPEG_QUALITY),
        tmpPng,
        "--out", tmpJpg,
      ], (err) => {
        if (err) reject(new Error(`sips resize failed: ${err.message}`));
        else resolve();
      });
    } else {
      // ImageMagick convert
      execFile("convert", [
        tmpPng,
        "-resize", `${RESIZE_WIDTH}x>`,
        "-quality", String(JPEG_QUALITY),
        tmpJpg,
      ], (err) => {
        if (err) reject(new Error(`convert resize failed: ${err.message}`));
        else resolve();
      });
    }
  });

  // Clean up the full-res PNG, atomically place the JPEG
  await unlink(tmpPng).catch(() => {});
  await rename(tmpJpg, filepath);
  return filepath;
}

/**
 * Collect screenshots from the inbox. Samples at most 3 (first, middle, last)
 * to avoid overloading the agent. All files are moved to processed.
 */
export async function collectScreenshots(inboxDir: string, processedDir: string): Promise<Screenshot[]> {
  await mkdir(processedDir, { recursive: true });

  const files = await readdir(inboxDir);
  const all = files
    .filter((f) => f.startsWith("screenshot-") && (f.endsWith(".jpg") || f.endsWith(".png")))
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
      const data = await readFile(filepath);
      const base64 = data.toString("base64");
      const tsMatch = file.match(/screenshot-(\d+)\./);
      const timestamp = tsMatch ? new Date(parseInt(tsMatch[1]!, 10)) : new Date();
      results.push({ path: filepath, timestamp, base64 });
    }

    // Move all to processed regardless
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
    return files.filter((f) => f.startsWith("screenshot-") && (f.endsWith(".jpg") || f.endsWith(".png"))).length;
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
