// Bundles the pi-runtime into a single self-contained JS file for packaging
// with the desktop app. Node built-ins stay external; everything else
// (@earendil-works/*, typebox) is inlined so no node_modules are needed.
import { build } from "esbuild";

const result = await build({
  entryPoints: ["dist/index.js"],
  outfile: "dist/pi-runtime.bundle.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "bundle",
  external: ["node:*"],
  // Bundled CJS deps (e.g. cross-spawn) require builtins without the `node:`
  // prefix; shim require for the ESM output.
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}
