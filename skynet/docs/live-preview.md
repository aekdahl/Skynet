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

---

## Deploy to Fly.io (persistent, human-triggered)

Everything above is **ephemeral by design**: a scratch worktree running a
local dev server, torn down on stop/restart, never independently reachable
once Skynet itself isn't running. That's exactly right for "watch the app
change as the fleet merges" — but it can't answer "send someone this link" or
"verify this survives a restart." **Deploy to Fly.io** is a second,
additive option for that case: a REAL app on Fly's infrastructure, with a
real `https://<app>.fly.dev` URL, that keeps running independent of the local
Skynet process. The operator picks per use-case — both buttons sit side by
side on the project view ("▶ Preview app" vs. "⇪ Deploy to Fly.io").

**The one rule that matters:** this is **only ever started by an explicit
operator click**. It is never wired into the autonomy loop, the merge queue,
or any automatic trigger — a real deploy costs real money and creates a real
public surface, so a human clicks it, every time.

### Two targets, one engine

- **Project** — deploys the **integration branch** (the fleet's cumulative
  merged state), same slice the local preview's "Merged" source shows.
- **Run** — deploys a single **run's own branch**, for pre-merge verification
  with a real shareable URL (as opposed to the local per-run preview, which is
  still ephemeral).

Both go through the same `FlyDeployManager` (`apps/server/src/fly/deploy.ts`),
keyed the same way the local preview is (`projectId`, or `run:<runId>`).

### Reuses the local preview's worktree machinery

A warm worktree with the right deps is the same prerequisite for both a local
dev server and a Fly deploy — only what runs *after* differs. `prepareWorktree`
and `ensureDeps` were extracted out of `project-preview.ts` into
`apps/server/src/preview/worktree.ts` so both engines share one
implementation; the local preview manager now delegates to it (unchanged
behavior — covered by its existing tests).

### Extends `.skynet/preview.json`, doesn't replace it

Rather than invent a second descriptor format, this reuses the SAME
`.skynet/preview.json` — including `build`/`outputDir`, declared back in
Phase 1 but unused until now — plus a new `fly` sub-block for what's genuinely
Fly-specific:

```json
{
  "dev": "npm run dev",
  "build": "npm run build",
  "outputDir": "dist",
  "fly": {
    "app": "my-project-ab12cd34",
    "region": "iad",
    "size": "shared-cpu-1x",
    "memory": "256mb",
    "org": "my-fly-org"
  }
}
```

Every `fly.*` field is optional and operator-overridable; the defaults are
Fly's smallest/cheapest (`shared-cpu-1x` / `256mb`, region `iad`) so a bare
`{}` — or no `fly` block at all — never surprises anyone with cost.
`fly.org` is only needed for a multi-org Fly account (a non-interactive
deploy can't answer flyctl's org prompt).

**App naming.** Fly app names are globally unique. Without an explicit
`fly.app`, one is derived deterministically from the project name + a short
hash of the project id (`slugify(name)-<hash(id)>`) — the same project always
derives the same app name (a redeploy is idempotent, never a second app), and
two different projects with the same display name never collide with each
other. On the rare occasion the derived (or explicit) name is already taken
by an unrelated Fly app, the deploy retries with a deterministic suffix
(`<name>-1`, `<name>-2`, …) rather than failing outright.

### Two deploy shapes, chosen by the descriptor

- **Static site** (`build` set) — runs the build **locally**, in the same
  warm worktree the local preview uses (`ensureDeps` + the `build` command),
  then ships a minimal generated `Dockerfile` (nginx serving `outputDir`) and
  `fly.toml`. Fully deterministic, no flyctl auto-detection involved. A
  repo-committed `Dockerfile`/`fly.toml` is respected and never overwritten.
- **Service** (no `build` — a real backend) — **no local install or build at
  all.** `flyctl launch --no-deploy` generates a `fly.toml` (detecting a
  Dockerfile/buildpack strategy) the first time, then `flyctl deploy` builds
  **inside Fly's own build container**. This is deliberate, not just
  simpler: reusing the local `node_modules` for a container's shipped
  artifact would risk shipping macOS-built native deps into a Linux image —
  a footgun the local dev-server preview never hits (it *runs* on the local
  OS) but a shipped container absolutely would.

### Mechanism: the `flyctl` CLI

Skynet shells out to the real `flyctl` binary (`apps/server/src/fly/fly-bin.ts`
resolves it — mirrors `git-bin.ts`'s handling of a GUI app's bare PATH, plus
flyctl's own `~/.fly/bin` install location) rather than calling the Fly
Machines REST API directly. **Trade-off, noted explicitly:** shelling out
means depending on an external binary being installed (flyctl isn't bundled),
whereas a direct API client would have zero extra runtime dependency — but it
matches this codebase's own precedent (`git-bin.ts` wraps a real `git` the
same way) and rides a battle-tested, actively-maintained tool instead of a
hand-rolled Machines API client that would need to track Fly's API changes
itself. Auth is the standard headless flyctl path — `FLY_API_TOKEN` in the
child's env, resolved from the stored credential, never written to disk.

### Fly.io API tokens, via the existing `SecretStore`

A Fly token is the same shape of secret as a GitHub PAT or an LLM key, so it
goes through the exact same `SecretStore` (`apps/server/src/secrets/`) —
not a new store. `fly` is a new `CredentialProvider` (alongside the LLM
`ProviderId`s and `github`), added in **Integrations** the same way an
additional GitHub account is (`FlyAccounts`, mirroring `GithubAccounts`), and
pinned per-project the same way (`Project.flyCredentialId`, mirroring
`githubCredentialId`) via the identical select-a-credential UI pattern
(`ProjectFlyAccount`, mirroring `ProjectGithubAccount`). No default/workspace-
wide Fly connection concept beyond "the credential named as the default" —
same as GitHub's additional accounts.

### Deployment state — a new status, alongside the existing preview

`Project.flyDeployment` / `TaskRun.flyDeployment` (a `FlyDeployment` record:
`status` — `idle`/`deploying`/`live`/`failed`/`stopped` — `appName`, `region`,
`url`, `branch`, `sha`, `error`, `deployedAt`, `deployedBy`) is a sibling
field next to the existing `PreviewState`, never replacing it. Unlike the
local preview's `PreviewState` (purely in-memory, gone on restart — that's
correct, since the local dev server itself is gone too), the Fly deployment's
*terminal* state is **persisted** on the Project/TaskRun record: the Fly app
keeps running whether or not Skynet does, so the UI needs to still say
"live at https://…" after a Skynet restart. In-flight build/deploy logs
stream from an in-memory ring buffer (ephemeral — acceptable, since they're
only useful while watching a deploy happen).

### Teardown — explicit only, never automatic

A Fly app can cost money even idle (plan-dependent), so there is deliberately
**no auto-teardown** — not on Skynet restart (unlike the local preview
worktree, which stop() removes every time), not on project delete, not ever,
except an operator clicking "Stop & destroy" (behind a confirm dialog — it's
irreversible; redeploying creates a fresh app). The UI is explicit about the
distinction: "Preview app" is labeled ephemeral, "Deploy to Fly.io" is labeled
persistent-until-you-stop-it.

### What's tested vs. what needs a real Fly account

Everything that doesn't need network or a Fly account is unit-tested:
descriptor parsing, app-name derivation + collision retry, the generated
`fly.toml`/`Dockerfile`, `flyctlBin()` resolution, and the credential
round-trip through `SecretStore` (`tests/fly-descriptor.test.ts`,
`tests/fly-bin.test.ts`, `tests/credentials.test.ts`,
`tests/secrets-verify.test.ts`). The static-site deploy path's full
orchestration (worktree → local build → generated deploy assets → app-name
collision retry → teardown) is exercised end-to-end against a real git repo
and a **fake** `flyctl` binary standing in for the real one
(`tests/fly-deploy-static.test.ts`) — no network, no account, but proves the
manager's control flow is correct.

**Needs manual verification with a real Fly account** (not fabricable in
CI/this environment): that a genuine `flyctl deploy` against Fly's real
builders/API succeeds for both the static-site and service paths, that the
resulting URL actually serves the app, that the "service" path's
`flyctl launch` auto-detection behaves sanely across a few real frameworks,
and that `flyctl apps destroy` genuinely stops billing / removes the app.
