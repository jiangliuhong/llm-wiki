// Builds the pi-runtime single-file bundle and stages it where the Tauri
// bundle picks it up as a resource (apps/desktop/src-tauri/pi-runtime/index.js).
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "apps", "pi-runtime");
const stagedDir = join(root, "apps", "desktop", "src-tauri", "pi-runtime");
const bundle = join(runtimeDir, "dist", "pi-runtime.bundle.js");

execSync("pnpm --filter @llm-wiki/pi-runtime build:bundle", { cwd: root, stdio: "inherit" });

rmSync(stagedDir, { recursive: true, force: true });
mkdirSync(stagedDir, { recursive: true });
copyFileSync(bundle, join(stagedDir, "index.js"));
console.log(`staged pi-runtime bundle at ${stagedDir}/index.js`);
