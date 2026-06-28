# GitHub Integration — Contract & Architecture

> Status: **design / contract**. The FE surface (connect flow + safety panel +
> Integrations view) ships in the prototype (`github.jsx`); the server pieces
> described here are the contract for the backend lanes (Core / Lane A) to build.
> Companion: `docs/vcs-and-conflict-model.md` (branch-per-agent + merge engine).

## 1. Principles

1. **GitHub App, not OAuth/PAT.** Skynet authenticates as a GitHub App installation,
   not as a user and not via a long-lived personal token. This gives per-repo,
   fine-grained, least-privilege permissions, short-lived auto-refreshed tokens,
   org-level install/revoke, and a webhook channel.
2. **PR-first.** Agents never mutate the default branch directly. Work flows
   `branch (agent/<id>) → commits → PR → checks → review → merge`. Aligns with the
   one-branch-per-agent model and the merge engine.
3. **Least privilege.** Request only the permissions below; scope to selected repos.
4. **Safety is server-enforced.** Every guardrail (§5) is checked server-side in a
   pre-write hook. The client toggles reflect policy; they never *are* the
   enforcement. A bypassed client cannot defeat a guardrail.
5. **No secrets at rest.** Store the App private key in a secret manager; never
   persist installation tokens — mint on demand, cache in memory until expiry.
6. **One repo per project.** A Skynet project binds to exactly one repository
   (`Project.repo`); all of that project's agents branch and PR within it. An
   installation may grant many repos, but each project pins a single one — this
   keeps branch-per-agent and the merge engine scoped to one repo at a time.

## 2. GitHub App

### Permissions (fine-grained)

| Permission       | Level        | Why                                        |
| ---------------- | ------------ | ------------------------------------------ |
| Contents         | Read & write | branch, commit, push agent work            |
| Pull requests    | Read & write | open / update PRs for review               |
| Checks           | Read         | surface CI status on the agent             |
| Metadata         | Read         | mandatory baseline                         |

> Deliberately **not** requested: Actions write, Administration, Secrets, Members.
> Merging respects branch protection; Skynet does not need admin to do its job.

### Webhook events

`installation`, `installation_repositories`, `push`, `pull_request`,
`pull_request_review`, `check_suite`, `check_run`.

### Install flow

1. Operator clicks **Install Skynet GitHub App** → redirect to
   `https://github.com/apps/<app-slug>/installations/new` (optionally pre-scoped via
   the App "request" URL with `state` = `workspaceId` for CSRF + mapping).
2. GitHub redirects back with `installation_id`; we also receive an `installation`
   webhook. Persist the `installation_id ↔ workspaceId` mapping.
3. Operator selects repositories (all or a subset). We mirror the selection from the
   `installation_repositories` webhook / `GET /installation/repositories`.

### Token exchange (server-only)

```
App JWT     = sign({iss: APP_ID, iat, exp:+10m}, APP_PRIVATE_KEY, RS256)
InstToken   = POST /app/installations/{installation_id}/access_tokens   (Bearer JWT)
            → { token, expires_at (~1h), permissions, repository_selection }
```

Cache `InstToken` in memory keyed by `installation_id`; refresh when `expires_at`
is within a 5-minute skew. Never log or persist it.

## 3. Connection model (contract types)

Pre-land in `packages/shared` (Core owns the spine). Shapes the FE already speaks:

```ts
export interface GithubInstallation {
  id: number;                 // GitHub installation id
  account: string;            // org or user login
  type: 'Organization' | 'User';
  appSlug: string;
}
export interface GithubRepo {
  id: number;
  name: string;               // "owner/repo"
  defaultBranch: string;
  private: boolean;
  selected: boolean;          // included in this installation's selection
}
export interface SafetyPolicy {
  prOnly: boolean;            // no direct pushes to the default branch
  noForcePush: boolean;       // block force-push / history rewrite
  moduleAllowlist: boolean;   // agent may only touch its assigned modules
  approveBeforePush: boolean; // HITL gate before push/merge
}
export interface GithubConnection {
  workspaceId: string;
  connected: boolean;
  installation: GithubInstallation | null;
  repos: GithubRepo[];
  safety: SafetyPolicy;       // defaults: all true
}
```

`SAFETY_DEFAULTS` = every flag `true`.

## 4. Agent git operations (the `GitProvider` seam)

Agents never shell out to `git` against GitHub directly; they call a provider that
holds the installation token and enforces §5. One implementation per host
(`GitHubProvider` first).

```ts
export interface GitProvider {
  ensureBranch(repo: string, branch: string, fromRef: string): Promise<void>;
  commitFiles(repo: string, branch: string, files: FileChange[], msg: string): Promise<{ sha: string }>;
  push(req: PushRequest): Promise<PushResult>;        // runs the safety preflight
  openPr(repo: string, head: string, base: string, title: string, body: string): Promise<{ number: number; url: string }>;
  prStatus(repo: string, number: number): Promise<PrStatus>;
  merge(repo: string, number: number, method: 'merge'|'squash'|'rebase'): Promise<MergeResult>;
  syncBase(repo: string, branch: string, base: string): Promise<void>;  // pull/rebase base into agent branch
}
```

`PushRequest` carries `{ workspaceId, agentId, repo, branch, files }` so the
preflight has everything it needs to evaluate policy.

## 5. Safety policy — enforcement

Evaluated in `push()` / `merge()` **before** any GitHub write. Returns a typed
rejection (surfaced to the agent log + Inbox), never a silent drop.

| Flag                 | Enforcement |
| -------------------- | ----------- |
| `prOnly`             | Reject any `push`/`merge` whose target is the repo default branch. Direct writes only allowed to `agent/*` branches. Also assert GitHub branch protection on the default branch is on (warn if not). |
| `noForcePush`        | Reject non-fast-forward updates / `force` flag on agent branches. |
| `moduleAllowlist`    | Resolve each changed path through `.skynet/modules.json` (see vcs-and-conflict-model §3) → module ids; reject if any path falls outside the agent's assigned modules. |
| `approveBeforePush`  | Instead of pushing, raise a HITL item (`kind: 'approval'`, the diff as payload) and park the op. On approve → execute the held push/merge (idempotent, first-writer-wins per the HITL model); on reject → discard. |

Policy is read per-workspace. Toggling a flag takes effect on the next op; it never
retroactively rewrites history.

## 6. Webhooks → event stream

Map GitHub webhooks onto the existing event bus so the UI updates live:

| GitHub webhook                      | Skynet event                          |
| ----------------------------------- | ------------------------------------ |
| `push` (agent branch)               | `agent.progress` / `agent.log`       |
| `pull_request` opened/synchronized  | `agent.log` (+ link PR to agent)     |
| `check_run` / `check_suite`         | `agent.log` (CI status), gate review |
| `pull_request` closed & merged      | `agent.completed`                    |
| `pull_request_review` changes_req   | `hitl.raised` (revision needed)      |
| `installation` deleted              | mark connection disconnected         |

Verify every webhook with the App webhook secret (HMAC-SHA256 over the raw body).

## 7. REST surface (server)

```
GET    /api/github                      → GithubConnection (workspace-scoped)
GET    /api/github/install-url          → { url } (App install redirect w/ state)
GET    /api/github/callback             ← GitHub redirect (installation_id, state)
GET    /api/github/repos                → GithubRepo[] (from the installation)
PUT    /api/github/repos                ← { repoIds: number[] } update selection
PUT    /api/github/safety               ← SafetyPolicy (partial) → updated policy
DELETE /api/github                      → revoke / forget installation
POST   /api/github/webhook              ← GitHub webhooks (HMAC-verified)
```

All workspace-scoped via the existing `resolvePrincipal`/token auth. The connection
+ policy persist via the `Store` (new `getGithubConnection` / `putGithubConnection`).

## 8. Failure modes

- **Token expiry mid-op** → transparent refresh + single retry.
- **Permission revoked / app uninstalled** → next op fails closed; surface a
  "reconnect GitHub" banner; never fall back to a user PAT.
- **Branch protection blocks merge** → respected, not bypassed; merge waits for
  required reviews/checks. Surface the reason in the Inbox.
- **Rate limits** → installation tokens are per-installation; back off on
  `x-ratelimit-remaining`, queue writes.

## 9. Lane handoffs

- **Core** — pre-land the §3 contract types in `packages/shared`; add
  `Store.get/putGithubConnection`.
- **Lane A (Auth)** — installation ↔ workspace mapping lives next to the workspace
  store; webhook signature verification alongside `auth.ts`.
- **Lane D (Module map)** — `moduleAllowlist` reuses `modules-map.ts`
  (glob → module id) to classify changed paths.
- **Runner SDK** — runners call `GitProvider`, not raw git, so the preflight always
  runs.
