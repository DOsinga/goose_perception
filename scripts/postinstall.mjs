#!/usr/bin/env node

import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PLATFORMS = {
  "darwin-arm64": "@aaif/goose-binary-darwin-arm64",
  "darwin-x64": "@aaif/goose-binary-darwin-x64",
  "linux-arm64": "@aaif/goose-binary-linux-arm64",
  "linux-x64": "@aaif/goose-binary-linux-x64",
  "win32-x64": "@aaif/goose-binary-win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PLATFORMS[key];

if (!pkg) {
  console.warn(
    `goose_perception: no prebuilt goose binary for ${key}. ` +
      `Install goose on PATH or use --server.`,
  );
  process.exit(0);
}

let binaryPath;
try {
  const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  const binName = process.platform === "win32" ? "goose.exe" : "goose";
  binaryPath = join(pkgDir, "bin", binName);
} catch {
  console.warn(
    `goose_perception: optional dependency ${pkg} not installed. ` +
      `Install goose on PATH or use --server.`,
  );
  process.exit(0);
}

// Ensure the binary is executable (npm doesn't always preserve permissions)
try {
  chmodSync(binaryPath, 0o755);
} catch {
  // may fail on Windows, that's fine
}

const outDir = join(__dirname, "..");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "server-binary.json"),
  JSON.stringify({ binaryPath }, null, 2) + "\n",
);

console.log(`goose_perception: found native goose binary at ${binaryPath}`);
