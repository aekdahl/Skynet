// Bundle the Skynet server into a single self-contained CJS file for packaging.
//
// Electron ships its own Node, so instead of dragging the monorepo's symlinked
// pnpm node_modules into the installer we esbuild the already-compiled server
// (apps/server/dist/index.js) into one file with every dependency inlined. The
// orchestrator's runner imports are static string literals, so all five
// providers bundle in too — no node_modules ships with the app.
//
// NOTE: the CLI-spawn providers (cursor/codex/gemini/copilot) and the mock
// runner work from the bundle as-is; they invoke external CLIs the user installs.
// The Claude Agent SDK is bundled but resolves a CLI binary relative to its
// module at runtime, so the claude runner's in-app execution still needs a
// validation pass on a real packaged build (it works in `pnpm dev`).

import { build } from "esbuild";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repoRoot = join(desktop, "..", ".."); // skynet/
const serverEntry = join(repoRoot, "apps/server/dist/index.js");
const outDir = join(desktop, "build");

if (!existsSync(serverEntry)) {
  console.error(`✗ ${serverEntry} not found — run \`pnpm -r build\` in the workspace first.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [serverEntry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(outDir, "server.cjs"),
  logLevel: "info",
  // static.ts derives the SPA dir from import.meta.url, but the packaged app
  // always sets WEB_DIST explicitly, so rewriting it to the bundle path is safe.
  define: { "import.meta.url": "__skynetServerBundleUrl" },
  banner: { js: "const __skynetServerBundleUrl = require('node:url').pathToFileURL(__filename).href;" },
});

console.log(`✓ server bundled → ${join(outDir, "server.cjs")}`);
