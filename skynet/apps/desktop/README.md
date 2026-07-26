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

## Environment, settings & data

All state and config live under the app's **user-data dir** — macOS
`~/Library/Application Support/Skynet/`, Windows `%APPDATA%/Skynet/`, Linux
`~/.config/Skynet/`. There is **no `.env` in the app bundle**; the shell builds
the server's environment at launch:

| File | What it is |
|------|------------|
| `skynet-data.json` | projects / runs / audit — `STORE=file` |
| `skynet-master.key` | per-install key (mode `0600`) for the encrypted secret store; generated on first run |
| `skynet.env` | optional `KEY=value` overrides, read at engine boot |

### Provider keys → in-app **Settings** (recommended)

Add your `ANTHROPIC_API_KEY` (and other provider keys) in **Settings**. They're
encrypted with the master key and applied **live — no restart**. This is the
normal path; no file editing.

### Operator knobs → **Settings → Advanced**

Everything that isn't a provider key (Telegram, runner-safety limits, pre-merge
check, vendor CLI paths) lives in the **Advanced** panel. It writes a curated
**whitelist** (source of truth: `apps/server/src/settings/env-settings.ts`) to
`skynet.env` and applies changes with the panel's **"Restart engine"** button:

- **Telegram** — `SKYNET_TELEGRAM_BOT_TOKEN` (secret), `SKYNET_TELEGRAM_OWNER_CHAT_ID`,
  `SKYNET_TELEGRAM_CONTROL`. *(The notification/control feature that reads these
  ships separately; the panel just makes them configurable + applied.)*
- **Runner safety** — `SKYNET_RUNNER_SANDBOX`, `SKYNET_RUNNER_MAX_RUNTIME_MS`.
- **Integration** — `SKYNET_CHECK_CMD`.
- **Vendor CLI paths** — `CODEX_BIN`, `GEMINI_BIN`, `SKYNET_CURSOR_BIN`,
  `SKYNET_COPILOT_BIN`, `SKYNET_HERMES_BIN`.

**Why restart:** most of the server's `config` is read **once at boot**, so a
changed value only applies on the next engine launch. The panel stages the change
to `skynet.env`, then the server exits with a sentinel code the shell **respawns**
on (with the fresh env) — the window stays open and reconnects. Provider keys are
the exception (live, above).

### Editing `skynet.env` directly (power users / headless)

You can hand-edit the same file the Advanced panel writes — handy for scripting
or a no-UI setup:

```
ANTHROPIC_API_KEY=sk-ant-...
SKYNET_INTEGRATION_REPO=/path/to/your/repo
RUNNER=mock            # optional: keyless demo (no provider needed)
```

Values the shell sets itself (`NODE_ENV`, `STORE`, `WEB_DIST`, `PORT`, `HOST`,
`SKYNET_DB_PATH`, `SKYNET_MASTER_KEY`) always win — the plumbing can't be
overridden here.

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
