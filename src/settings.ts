import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const SETTINGS_FILENAME = "settings.json";

export interface Settings {
  fastProvider: string;
  fastModel: string;
  smartProvider: string;
  smartModel: string;
  screenshotIntervalSecs: number;
}

const DEFAULTS: Settings = {
  fastProvider: "",
  fastModel: "",
  smartProvider: "",
  smartModel: "",
  screenshotIntervalSecs: 5,
};

export async function loadSettings(rootDir: string): Promise<Settings> {
  const path = join(rootDir, SETTINGS_FILENAME);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(rootDir: string, settings: Settings): Promise<void> {
  const path = join(rootDir, SETTINGS_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
