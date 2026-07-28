# Live preview — "see what the fleet builds"

**Problem.** A human overwatching agents needs to *see the running app*, not just
read diffs — and see it **update as changes merge in**, to verify work in-context.
Today's preview is per-agent-*branch* and effectively static/web (an artifact
served under `/preview/:runId`). This brief specifies a **per-project live
preview** that tracks the integration branch, refreshes as the fleet merges, and
opens **split-screen or as a modal** beside the board.

Scope order (per product decision): **Phase 1 = web apps & websites** (committed);
Phase 2 = full-stack services; Phase 3 = everything else. This doc details Phase 1
and sketches 2–3.

---

## Core model

- **Source of truth = the integration branch** (`skynet/integration/<projectId>`)
  — the cumulative state the fleet has merged. The preview runs against a
  dedicated **preview worktree** of that branch (never the operator's own
  checkout, which may be dirty — same rule the merge engine follows).
- **Live loop (the overwatch magic):**
  ```
  agent merges → integration branch advances → Skynet refreshes the preview
  worktree (git checkout/pull) → the dev server's file-watcher (HMR) pushes the
  change into the iframe → operator sees the app update live
  ```
  For frameworks with HMR (Vite/Next/…), this is automatic. For others, Skynet
  does a debounced rebuild + soft iframe reload on merge. Either way it emits a
  `preview.state` event so the UI shows freshness and can reload.
- **Two scopes, one seam:** the **project** preview (integration branch, the
  default "overwatch" view) and the existing **per-run branch** preview (verify a
  single agent's change *before* approving its diff gate). Same UI shell.

## How a preview is started — agent-assisted, with deterministic fallbacks

Rather than hard-code framework detection, resolve the run recipe in escalating
order (first hit wins):

1. **Descriptor** — `.skynet/preview.json` in the repo:
   `{ kind, install, dev, build, outputDir, port, healthPath }`. Repo-native and
   operator-overridable (like the module map). The explicit, reproducible source.
2. **Heuristic** — read `package.json`: a `dev`/`start`/`serve` script + a
   framework hint (Vite/Next/CRA/Astro/plain `index.html`) → a default recipe.
   Covers the common case with zero config.
3. **Agent-assisted** — when neither is conclusive, ask the **repo-aware
   assistant** (the same BYOK `oneShotRepoAssistant` behind "Ask about this
   project" / the Telegram agent) to read the repo and **propose** a recipe
   (install + start command + port), returned as strict JSON. The operator
   confirms/edits it once; the confirmed recipe is written back to
   `.skynet/preview.json` so it's deterministic next time. This is point (1)/(2)
   from the product decision: the general agent figures out — and can start —
   most previews from a terminal command.

The agent can also **start the preview itself** via a scoped tool (it already
runs commands under the safety classifier + sandbox), so "get the preview up" can
be an operator ask ("preview this") the agent fulfils.

## Running it (Phase 1: web) — desktop-first

- **Spawn** the resolved `dev` (preferred, for HMR) or `build`+serve command as a
  **sandboxed child process** (opt-in OS sandbox, write-confined to the preview
  worktree; the containerized runner on the hosted side later), `cwd` = the
  preview worktree, `PORT` injected, stdout/stderr captured to a ring buffer.
- **Health-check** the port until it answers; then the preview is `live` at
  `http://127.0.0.1:<port>`.
- **Desktop = no proxy needed:** the SPA iframes the dev server's localhost port
  directly (same machine). The **reverse proxy at `preview.<project>.<host>`** is
  only the hosted variant.
- **One preview process per project**, lifecycle: start on open · **idle-timeout
  auto-stop** (bounds resource use) · **manual start / stop / restart / refresh**
  always available (per the product decision) · restart on descriptor change.
- Resource caps (the runner runtime/mem caps) apply to the preview process too.

## Sandboxing (non-negotiable — untrusted code with a server)

The previewed app is agent-written code running a server and rendering in a frame.
It must not reach the Skynet control-plane or the host broadly:

- Runs **write-confined** to its worktree, on a **separate origin** (its own
  localhost port) so its cookies/storage/JS are isolated from the console.
- The iframe stays `sandbox`ed with a strict `frame-ancestors`/CSP (extends the
  posture the current `/preview` route already enforces).
- Egress/network confinement rides the containerized runner (hosted, 🏢).

## The overwatch UX

- A **"Preview" affordance** on the project view (and a "Preview this change"
  button on a visual diff-review gate → the per-run branch preview).
- Opens as a **resizable split-screen** (board/agents left, live app right) with a
  **pop-out to a full modal / second window**; toggle between them.
- **Device-frame** (desktop/tablet/mobile widths) · **light/dark** · a **URL/route
  bar** to navigate the previewed app · a **freshness pill** ("live · updated 3s
  ago") · **reload** + **restart** · a **logs drawer** (so a failed build shows the
  error, never a blank frame).

## Phase 2 — full-stack services (later)

`kind: "service"` — run `start` (possibly multi-process: web + api via the
descriptor), health-check the port, reverse-proxy. The app's own env/secrets are
sandboxed and separate from Skynet's; optional ephemeral datastore. The
**containerized runner (v1)** does the isolation on the hosted side.

## Phase 3 — everything else (later)

`kind: "command"` — "preview" = **run it and show the result**: CLI output/exit,
a test run, or **artifacts rendered inline** (a produced PDF/image/report, a
built binary's `--help`, a notebook's output). Same split-screen/modal shell hosts
an output/artifact panel instead of an iframe. Covers libraries, data jobs, docs.

## Reuse (wrap, don't rebuild)

The existing `preview/` service + builder + sandboxed route; the integration
branch + worktree provisioner; the opt-in OS sandbox + runtime cap (v0 #5); the
repo-aware assistant (BYOK) for recipe detection/start; the WS hub for
`preview.state`; the `<iframe sandbox>` + device-frame in `components/preview.tsx`.
Skynet orchestrates build/run + (hosted) proxy — it does not reimplement a PaaS.

## Phase-1 v0 (this PR)

The first working slice, web + desktop:
- `ProjectPreviewManager` — one sandboxed preview process per project against an
  integration-branch preview worktree; state machine (`idle`/`starting`/`live`/
  `failed`/`stopped`) + log ring buffer; start/stop/restart/refresh; idle-stop.
- Recipe = descriptor → heuristic (agent-assist path stubbed behind the same
  resolver seam, wired next).
- API: `GET/POST /api/projects/:id/preview{,/start,/stop,/restart,/refresh}` +
  a `preview.state` WS event.
- Refresh-on-merge: `completeMerged` nudges a live preview to pull + reload.
- Web: split-screen Preview pane on the project view with device frame, URL bar,
  reload/restart, logs, freshness.

Deferred within Phase 1 (fast-follows): dev-server HMR polish across more
frameworks, the agent-assisted resolver's live call + write-back, and the
per-run pre-merge "Preview this change" button.
