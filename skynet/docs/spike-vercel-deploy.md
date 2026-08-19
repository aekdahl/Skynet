# Spike: Skynet Deploy — Vercel Vertical Slice

> **Status:** Proposal / spike writeup — no infra shipped.
> **Scope:** Vercel as the first concrete deploy target, with a hard requirement that
> the existing per-branch Preview capability (task `t-skynet-msdrfob1-13`) remains
> first-class throughout.

---

## 1. The question being answered

Can Skynet actively deploy solutions to external hosting providers, starting with
Vercel, while:

1. Keeping the ephemeral local Preview pipeline intact and first-class.
2. Fitting inside the runner-SDK provider abstraction (`t-skynet-msdrfo7o-10`) and
   the Guided provider connect UX (`t-skynet-msdrfodb-15`).
3. Not requiring a GitHub App today (the live integration uses the LOCAL merge engine
   with base branch `main` and no App configured).

This writeup answers that question and recommends a concrete v1 scope.

---

## 2. Fit with existing architecture

### 2.1 The three-layer picture

Skynet currently has three distinct abstractions that touch deployment:

| Layer | Interface | Purpose |
|---|---|---|
| **Runner-SDK provider** | `RunnerProvider` (`packages/runner-sdk/src/types.ts`) | *Code execution*: run an agent on a task (Claude Code, Codex, Gemini, …). |
| **Preview provider** | `PreviewProvider` (`preview/types.ts`) | *Review URL*: resolve a sandboxed iframe URL for a branch. Three modes: `off`, `artifact`, `deploy`. |
| **Deploy target** | `FlyDeployManager` (`fly/deploy.ts`) | *Durable publish*: ship the integration branch or a run's branch to a persistent external host. |

Vercel Deploy belongs squarely in the **Deploy target** layer — the same stratum as
Fly.io, not in the runner-SDK layer. Runner-SDK providers are code *executors*; deploy
targets are *publishers*. These are orthogonal concerns: any runner produces commits
on a branch, and then separately a deploy target picks up that branch and publishes it.

### 2.2 The Fly.io precedent

The existing `FlyDeployManager` (`fly/deploy.ts`) shows exactly how a deploy target
plugs into Skynet:

- **Auth**: a sealed `"fly"` credential in the secret store, resolved at deploy time
  (`flyApiToken` injected into the manager, never stored in plaintext).
- **Worktree reuse**: `prepareWorktree` / `ensureDeps` from `preview/worktree.ts` —
  the same warm checkout the local preview uses.
- **CLI delegation**: shells out to `flyctl` (no-shell, direct argv — no injection
  risk). Mirrors `git-bin.ts`'s pattern of wrapping a battle-tested external binary.
- **State model**: `FlyDeployStatus` (`idle | deploying | live | failed | stopped`),
  persisted as `FlyDeployment` on the `Project` and `TaskRun` Zod shapes in `contracts.ts`.
- **Trigger**: explicit operator action only, via `operations.ts`'s `flyDeploy*` methods
  gated behind a button click — never from the autonomy loop.

A `VercelDeployManager` would follow the same shape with one important difference
described in §3 (repo-integration wiring).

### 2.3 Preview vs Deploy — they are NOT the same thing

The Preview pipeline is per-*run* (per agent branch), ephemeral (tied to the local
Skynet process for the `artifact` provider), and scoped to reviewer/operator eyes.
Deploy is per-*project* (or per-run for pre-merge verification), durable (the
`https://<app>.vercel.app` URL survives a Skynet restart), and is what users/customers
hit.

These must stay separate. The current `deploy` preview mode is just a URL template
shorthand — it does NOT actually call any deploy API; it formats an external review
URL assuming something outside Skynet already did the deploy (e.g. Vercel's own GitHub
integration). A Skynet-initiated Vercel deploy is a different, additive thing.

### 2.4 Can Vercel do double duty (Preview + Deploy from one integration)?

This is the key architectural question. The answer is **yes, but with a meaningful
trade-off**:

**Vercel's native model:**
- **Preview deployments** — every push to a non-production branch gets a unique, per-commit
  preview URL (`https://<hash>-<project>.vercel.app`). Vercel creates these automatically
  when it sees a push to a connected repository. The URL is stable per commit, not per
  branch — a re-push changes the URL.
- **Production deployments** — a push to the production branch (usually `main`) promotes
  the build to the project's production domain.

**If Skynet uses Vercel's Git integration (push-triggered):**

Vercel would automatically create a preview deployment for every agent branch push AND a
production deployment whenever `main` is pushed. This is the simplest integration if
(and only if) a GitHub App is configured: Skynet pushes a branch → Vercel webhook fires
→ Vercel builds and generates a URL. Skynet would then need to poll the Vercel
Deployments API to get the URL and feed it back into the preview pipeline.

**If Skynet calls the Vercel API directly (pull-triggered, no webhook needed):**

The `vercel deploy --prebuilt` or `vercel deploy` CLI, or the Vercel REST API's
`POST /v13/deployments` endpoint, can initiate a deployment from a local file
tree — no GitHub push required, no webhook, no App dependency. The Vercel CLI
handles auth via a token (`VERCEL_TOKEN`), a project id, and an org id. This is
the path Fly.io already takes with `flyctl` and is the correct v1 model given the
current no-App constraint.

**Recommendation on dual-use:**

Use the **direct API/CLI path** (no GitHub integration) in v1 for both:
- *Preview deployments*: deploy the agent's worktree to Vercel on branch completion,
  use the resulting preview URL in the SPA iframe. This hardens the Preview pipeline
  (Vercel's CDN edge, not a local Express server) and gives reviewers a real public URL
  that survives Skynet restarts.
- *Production deployments*: promote the integration-branch build to the project's
  production domain on an explicit operator action.

This is additive, not a replacement: the existing `artifact` and `deploy` preview modes
stay unchanged for teams that don't want a Vercel account.

---

## 3. Prerequisites — exactly what wiring is required first

### 3.1 What is already in place

| Prerequisite | Status |
|---|---|
| Sealed credential store (`CredentialProvider`, `SecretStore`) | ✅ Done |
| Per-worktree checkout infrastructure (`prepareWorktree`, `ensureDeps`) | ✅ Done |
| Operator-triggered deploy pattern (`operations.ts` + `FlyDeployManager`) | ✅ Done |
| Per-project/run deploy state model (`FlyDeployment` shape in contracts.ts) | ✅ Fly-specific but reusable as a pattern |
| Preview provider abstraction (`PreviewProvider` interface) | ✅ Done |
| Guided provider connect UX (secrets/settings panel, provider cards) | ✅ Done (extensible) |

### 3.2 What Vercel needs that Fly doesn't

**The critical difference:** Fly.io's `flyctl deploy` runs the build **and** the deploy from
a local worktree in one shot. Vercel's equivalent (`vercel deploy`) does the same — but
the Vercel CLI needs the project to be **linked** to a Vercel project id before the first
deploy. This linking step (`vercel link`) is normally interactive.

Non-interactively, it requires:
- `VERCEL_TOKEN` (scope: personal access token or OAuth token for the team/account).
- `VERCEL_ORG_ID` (the team/user slug id from the Vercel dashboard or API).
- `VERCEL_PROJECT_ID` (created on first deploy via `vercel --yes`, or pre-created via API).

**No GitHub App required.** Vercel's CLI path is entirely token + project-id based.
No webhook, no OAuth App, no repository connection needed for the CLI push model.

**Build config:** Vercel auto-detects the framework (Next.js, Vite, CRA, etc.) from the
project root. If `.skynet/preview.json` declares a `build` command and `outputDir`,
those can be mapped to `vercel.json`'s `buildCommand`/`outputDirectory`. For the static
site path, `vercel --prebuilt` (deploy a pre-built `dist/`) skips Vercel's remote
builder entirely — fastest, most deterministic.

**Environment variables / secrets:** Vercel's project env vars are set via the dashboard
or `vercel env add`. For a Skynet-managed project, the operator would set app-level
secrets in Vercel's dashboard (not Skynet's secret store) — Skynet injects build-time
env vars only if it manages the build itself (the prebuilt path). Runtime secrets in a
Vercel Function are Vercel's responsibility; Skynet doesn't need to know about them.

### 3.3 What must be resolved before a Vercel deploy can run

In priority order:

1. **A Vercel personal access token** stored as a new `"vercel"` `CredentialProvider`
   in the secrets store. Same pattern as `"fly"`. This is the operator's Vercel API key.

2. **A Vercel project id** stored per Skynet project — either auto-created on first deploy
   (`vercel --yes` creates a new project and writes `.vercel/project.json`) or supplied
   by the operator. The project id is safe to store as plain metadata (not a secret).

3. **A Vercel org/team id** — also plain metadata, tied to the account the token belongs
   to. Can be auto-resolved from the token (GET `https://api.vercel.com/v2/user`).

4. **The `vercel` CLI on the server's PATH** — same auto-install pattern as
   `npm install -g @openai/codex` already used for Codex/Gemini/Copilot. The Vercel
   CLI is `npm install -g vercel`.

5. **`.skynet/preview.json` descriptor** — already used by both the local preview and
   the Fly deploy. No new format needed; the existing `build` / `outputDir` fields map
   directly to Vercel's build config.

No GitHub App. No webhook. No external VCS integration required.

---

## 4. Auth / build / env-var model

### Token model

| Secret | Where stored | How used |
|---|---|---|
| `VERCEL_TOKEN` | Skynet secret store, `CredentialProvider = "vercel"` | Passed as `--token` to Vercel CLI or as `Authorization: Bearer` to REST API. Never logged. |
| `VERCEL_ORG_ID` | Project metadata (not a secret) | Passed as env var to `vercel` CLI or stored in `.vercel/project.json`. |
| `VERCEL_PROJECT_ID` | Project metadata (not a secret) | Same as above. Auto-created on first deploy if absent. |

### Build model

Two paths, mirroring Fly:

**Path A — prebuilt static site** (`build` set in `.skynet/preview.json`):
1. `ensureDeps` on the agent's worktree.
2. Run the `build` command locally (same as `PreviewBuilder.run`).
3. `vercel deploy --prebuilt --prod <outputDir>` (or without `--prod` for preview).
4. Capture the returned deployment URL.

**Path B — Vercel-managed build** (no local `build` command):
1. Clone worktree.
2. `vercel deploy --yes --prod` — Vercel's remote builder detects framework, installs, builds.
3. Capture URL.

Path A is deterministic and testable locally. Path B is simpler to set up (zero config)
but slower (Vercel's builder queue). Path B is the default unless `.skynet/preview.json`
has a `build` field.

### Env-var / secrets handling

Build-time env vars (e.g. `VITE_API_URL`) the app needs at build time can be passed
via `vercel env add` (run once, stored in the Vercel project) or injected with
`--build-env KEY=VAL` on the CLI. Runtime secrets (Vercel Functions) are set in the
Vercel dashboard — Skynet doesn't manage these. This boundary is clean: Skynet owns
"deliver the built artifact to Vercel"; Vercel owns "serve it with the right runtime
config."

---

## 5. Preview vs Deploy semantics

| Dimension | Skynet Preview (current) | Vercel Deploy (proposed) |
|---|---|---|
| **Trigger** | Automatic, per agent run, on branch creation | Explicit operator action (same as Fly) |
| **Lifecycle** | Ephemeral; tied to local Skynet process (artifact mode) or a URL template (deploy mode) | Durable; survives Skynet restart; only torn down explicitly |
| **Scope** | Per-run (per agent branch) | Per-project (integration branch) or per-run (pre-merge verification) |
| **URL stability** | Per-run id (stable within a run) | Stable per Vercel project; production domain is permanent |
| **Audience** | Operator/reviewer (in SPA iframe) | Anyone with the URL; production = real users |
| **Build** | Local build on Skynet server | Local or Vercel's remote builder |
| **Rollback** | Delete the run | Vercel instant rollback via dashboard |

**How they coexist:** The existing `PREVIEW=artifact` or `PREVIEW=deploy` modes stay
unchanged. Vercel Deploy is a separate subsystem (parallel to Fly), triggered by a
"Deploy to Vercel" button alongside the existing "Deploy to Fly" button. A project can
have both a local preview URL (per-run iframe) AND a live Vercel production URL — these
don't conflict.

**Hardening the shaky preview pipeline via Vercel preview deployments:** Vercel's per-commit
preview URL *could* replace the `artifact` provider for teams that connect Vercel. Instead
of building locally and serving from this server, Skynet would call `vercel deploy`
(without `--prod`) on the agent's branch and use the returned Vercel preview URL as the
SPA's iframe target. This is strictly better for the preview use case — no local disk
space, CDN edge, no "building…" placeholder. BUT it requires an operator to have a Vercel
account and set up the credential, which is opt-in infrastructure. Keep it additive: a new
`PREVIEW=vercel` mode or a project-level `vercelPreview: true` flag would opt a project
into this path. The current `artifact` mode remains the zero-config default.

---

## 6. Recommendation: v1 vertical slice

### Recommended scope

**Implement a `VercelDeployManager`** that mirrors `FlyDeployManager` exactly, plus the
minimal credential/metadata wiring. This is the smallest change that delivers real value
(a durable public URL for a shipped project) without inventing new abstractions.

Specifically:

1. **Secrets store extension**: add `"vercel"` to `CredentialProvider` in `contracts.ts`.
   Store `VERCEL_TOKEN` encrypted. Store `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as plain
   metadata on the `Project` record (new nullable fields, defaulting to null — same shape
   as `flyDeployment`).

2. **`VercelDeployManager`** in `apps/server/src/vercel/deploy.ts`:
   - `start(opts)`: `prepareWorktree` → optionally run build → `vercel deploy --prod --token <t> --scope <org>`
   - `destroy(opts)`: `vercel remove --yes --token <t>` (removes the project's deployments).
   - `state(key)`: returns `{ status, url, deployedAt, error, logs }`.
   - CLI path: `npm install -g vercel` (same install-on-demand pattern as Codex).

3. **`operations.ts` additions**: `vercelDeployProjectStart`, `vercelDeployProjectStop`,
   `vercelDeployProjectState` — three methods mirroring the Fly equivalents exactly.

4. **API routes**: POST/DELETE/GET `/api/projects/:id/vercel` — same REST shape as the
   existing Fly routes.

5. **Provider requirements wiring**: `"vercel"` entry in `INSTALL_COMMAND` (npm global),
   `DOCS_URL`, `INSTALL_HINT` — so the Settings panel's "Install" button works.

6. **UI**: "Deploy to Vercel" button on the project panel, alongside "Deploy to Fly".
   Status card shows the Vercel URL when live.

**Explicitly out of scope for v1:**

- Vercel preview deployments as an alternative preview provider (the `PREVIEW=vercel`
  mode). This is additive and lower-risk after the basic deploy path is validated.
- Automatic deploys triggered by merges (the autonomy loop). Operator-action-only for v1.
- Netlify / Cloudflare Workers / other targets. The `VercelDeployManager` establishes the
  pattern; generalizing comes after one vertical slice is working.
- GitHub App / webhook wiring. Unnecessary for the CLI path.

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Vercel CLI version drift** | Low | Pin a minimum version check on startup (same as `fly-bin.ts`'s `flyctlBin()` pattern). |
| **Project linking is stateful** | Medium | The `.vercel/project.json` written by `vercel link`/`vercel --yes` lives inside the worktree dir. On a Skynet restart the worktree dir persists (same as Fly), so the link survives. If the worktree is GC'd, the next deploy recreates it. Store `VERCEL_PROJECT_ID` on the Project record as the authoritative source, not the `.vercel/` file. |
| **Vercel name collisions** | Low | Vercel project names are per-account (not globally unique like Fly app names). The derived name (`<slug>-<hash>`) won't collide. |
| **Build env var leakage** | Medium | Never log `--token` value. Redact token from CLI stderr output (same as `redactToken` in github/provider.ts). `--build-env` vars are not secret (build-time public); real secrets belong in Vercel's dashboard, not injected by Skynet. |
| **Remote builder queue latency** | Low | Path B (Vercel-managed build) can take 1-3 minutes. The existing 10-min `DEPLOY_TIMEOUT_MS` cap from Fly is appropriate. Stream logs to the UI so the operator sees progress. |
| **Vercel free-tier limits** | Low | Free tier has 100 deployments/day, 6000 build minutes/month. A small team running Skynet won't hit these. Document the limit; pro teams upgrade Vercel independently. |

### Proposed follow-up task breakdown

| Task | Estimated effort | Depends on |
|---|---|---|
| `t-vercel-creds` — Add `"vercel"` to `CredentialProvider`; wire secrets store + project metadata fields | Small (0.5 day) | — |
| `t-vercel-manager` — `VercelDeployManager`: start/destroy/state, CLI shell-out, log streaming | Medium (1 day) | `t-vercel-creds` |
| `t-vercel-ops` — `operations.ts` methods + API routes (mirrors Fly) | Small (0.5 day) | `t-vercel-manager` |
| `t-vercel-ui` — "Deploy to Vercel" button + status card in the project panel | Small (0.5 day) | `t-vercel-ops` |
| `t-vercel-preview` — `PREVIEW=vercel` mode: per-run preview deployments via Vercel CLI | Medium (1 day) | `t-vercel-manager` |
| `t-vercel-generalize` — Abstract `DeployTarget` interface from Fly + Vercel for Netlify/CF | Medium (1 day) | Both managers working |

Total for production deploy (tasks 1–4): ~2.5 days of focused engineering.
Preview hardening via Vercel (task 5): +1 day, can be done in parallel.

---

## 7. Summary recommendation

**Build a `VercelDeployManager` that clones the Fly.io pattern exactly.** No new
abstractions needed — the Fly deploy already proved the shape. The delta is:

- `"vercel"` added to `CredentialProvider`.
- A `vercel/deploy.ts` module (shelling out to the Vercel CLI, same pattern as `fly-bin.ts`).
- Three `operations.ts` methods + REST routes.
- A UI button and status card.

**No GitHub App, no webhooks, no runner-SDK changes.** The CLI path (`vercel deploy
--token`) is self-contained. The existing Preview pipeline is untouched; the Vercel
deploy is a parallel, additive capability.

**The double-duty question** (one Vercel integration for both preview hardening AND
production deploy) is worth doing eventually, but as a second step: ship the production
deploy first (smaller, more immediately valuable), then add `PREVIEW=vercel` mode to
replace the shaky local artifact server for teams that want it.

**Generalizing to Netlify / Cloudflare / others** should happen after both Fly and
Vercel are working — at that point the `DeployTarget` abstraction becomes obvious from
two concrete implementations rather than speculative.
