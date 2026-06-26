# Skynet desktop

Runs Skynet on your own machine: a single window over a local Skynet server.
No SaaS, no Docker, no database — state is a JSON file under your OS per-user
data dir (`STORE=file`). Your repo and provider keys never leave the machine.

## How it works

```
Electron main (main.cjs)
  └─ spawns the Skynet server as a plain-Node child (ELECTRON_RUN_AS_NODE=1)
       STORE=file   SKYNET_DB_PATH=<userData>/skynet-data.json   WEB_DIST=<bundled SPA>
  └─ waits for /health, then opens a window on http://127.0.0.1:8099
```

- **dev** runs the workspace server at `apps/server/dist/index.js`.
- **packaged** runs an esbuild single-file bundle at `resources/server.cjs`
  with every dependency inlined, so the installer carries no `node_modules`.

> The mock and CLI-spawn providers (cursor/codex/gemini/copilot — which invoke
> external CLIs you install) work from the bundle. The **Claude Agent SDK
> runner** is bundled too but resolves a CLI binary relative to its module at
> runtime, so its execution inside a *packaged* build still needs a validation
> pass (it works in `pnpm dev`).

The app is intentionally **excluded from the pnpm workspace** (`!apps/desktop`
in `pnpm-workspace.yaml`) so its heavy Electron toolchain stays out of the main
CI install. Install it standalone with `--ignore-workspace`.

## Run in development (hot reload — recommended)

One-time: `cd apps/desktop && pnpm install --ignore-workspace`. Then from the
repo root (`skynet/`):

```bash
pnpm desktop:dev
```

This runs the server in watch mode (:8099, file store + a dev master key), Vite
with HMR (:5173, proxying `/api` + `/ws` → :8099), and Electron pointed at Vite.
**Edit web → instant HMR in the window; edit server → it restarts automatically.**
No rebuilds, no relaunch. Dev state lives in a gitignored `.skynet-dev/`.

## Run the built shell (production-like)

Loads the *built* SPA from the in-process server (no HMR — rebuild to see changes):

```bash
pnpm -r --filter "./packages/**" build
pnpm --filter @skynet/server build
pnpm --filter @skynet/web build
cd apps/desktop && pnpm dev
```

## Configuring a real runner

By default the app uses the **mock** runner. To use a real provider, drop a
`skynet.env` file in the app's user-data dir (the path is printed by the OS;
e.g. `~/Library/Application Support/Skynet/skynet.env` on macOS):

```
RUNNER=claude
ANTHROPIC_API_KEY=sk-ant-...
SKYNET_INTEGRATION_REPO=/path/to/your/repo
```

(An in-app onboarding/settings screen will replace this file later.)

## Build installers locally

```bash
cd apps/desktop
pnpm dist        # current OS → release/
pnpm dist:mac    # macOS .dmg (arm64 + x64)
pnpm dist:win    # Windows .exe (nsis)
```

## Releases & auto-update

Pushing a `v*` tag runs `.github/workflows/desktop-release.yml`, which builds
the macOS + Windows installers and publishes them to that tag's GitHub Release.
`electron-updater` checks the same releases on launch and updates in the
background.

> **Code signing is deferred.** Builds are unsigned for now: macOS users must
> right-click → Open the first time, and macOS auto-update stays inactive until
> the build is signed (Windows background update works unsigned). Add an Apple
> Developer ID + Windows cert before wider distribution.

## App icon

`build-assets/icon.png` (1024×1024) is generated from `apps/web/public/icon.svg`;
electron-builder converts it to `.icns`/`.ico` at build time. Replace it with a
higher-fidelity render (with the Space Grotesk "S") when available.
