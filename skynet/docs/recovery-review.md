# Skynet — Recovery Review

**Date:** 2026-09-13 · **Basis:** read-only review of `origin/main` @ `4c7ac1b` · **Method:** five parallel
code audits (server core loop, web app, runner layer, test/QA surfaces, docs vs. reality) plus a hands-on
boot, API drive and UI walk. No repository files were changed. File references point at that commit.

> **Verdict.** The core loop is real and coherent inside one uninterrupted server process. Around it sit
> roughly fifteen subsystems that were stacked on before the loop was proven, a merge gate that never
> blocked anything, and a stated product that changed three times without the README noticing.
> **Recovery is a subtraction problem first and an autonomy problem second.**

| Figure | Meaning |
|---|---|
| 1,139 commits in 89 days | one human author; 516 co-authored by Claude |
| 0 branch-protection rules on `main` | the last 4 merged PRs each carried a failing build-test check |
| 35 % | of the last 30 days' commits are fix / hotfix / revert (92 of 262) |
| 7,764 lines | `orchestrator.ts`; ~15 subsystems, ~5 on the critical path |
| ~11 % | of server code is the actual autonomous build kernel (≈4.7k of 42k lines) |
| ~250 | server-side `.catch(() => undefined)` swallows, 168 in the orchestrator |

The companion plan is [build-plan.md](build-plan.md).

---

## 1. What I saw firsthand

| Step | What happened | What it means |
|---|---|---|
| Follow README §① "Demo — mock agents, zero external deps" | There is no mock runner. `packages/runner-sdk/src` has nine vendor adapters and no mock; `config.ts:68-72` says so. | A new user cannot try the loop without a paid key. README frozen since v0.1.0 (22 Jun). |
| Boot the server, open the SPA | "Connecting to mission control…" forever. The served bundle was built 11 Jul against contracts last changed 11 Sep. `Snapshot.parse` is atomic, the REST failure only logs, and the WS fallback snapshot is dropped silently (`store.tsx:614-620`, `client.ts:258, 1758`). | One drifted field anywhere in the contract hangs the app with no visible error. |
| Open the Vite dev build | Home: "Quiet night — nothing happened while you were away", four zero tiles, empty chart, no call to action. | First run is a dashboard of zeros. |
| Create a project with only a name | Defaults: `autonomy: true`, `approvalLevel: "trusted"`, 53 fields. | Autonomy on and medium-risk commands (incl. `git commit`) auto-approve by default. The memo's thesis is "graduated trust"; the default is trust. |
| Open the project page | 11 lenses, a Board/Timeline toggle, three board metaphors (Momentum, Gravity, Rail) over the legacy kanban. Lens choice persists in `sessionStorage`. | Four ways to look at one backlog; operators land on views they did not pick. |
| Open Inbox / Fleet | Inbox copy says "one of four gates"; the contract has nine HITL kinds. Fleet says "catalog: Claude, Codex, Gemini, Cursor, Copilot"; providers endpoint returns nine. | UI copy drifted from the contract. |
| Check CI and the nightly | CI on `main` red since 11 Sep 06:11 UTC. "LLM-E2E (nightly)" is green in 37 s because it exits 0 with no API-key secret, and none is set. | The only automated surface that would run a real agent has never run. |

**Sensitive data, public repo.** Plaintext MFA recovery codes were committed in PR #647 (3 Sep), untracked in
PR #700, and remain in history (`d3ec63a`). Treat them as burned. The dev server writes a fresh
`mfa-recovery-codes.txt` on every boot; `skynet/.env` in the primary checkout holds live provider keys.

---

## 2. Where the loop breaks

Intended loop: assign → acquire runner → worktree on `agent/<run>` → agent works → commit + diff review →
approve → merge queue → checks → done. It holds in local-repo mode inside a single process. Ranked by blast
radius:

| # | Sev | Defect | Evidence | Effect |
|---|---|---|---|---|
| 1 | critical | Finished work never reaches the user's branch | Local mode merges into `skynet/integration/<pid>`; nothing merges/pushes it to base. GitHub mode marks task+run *done* when the PR opens and skips `checkCmd`. `merge.ts:172-173, 265-268` · `orchestrator.ts:3214-3225, 4574-4576` | "Done" ≠ on `main`. |
| 2 | critical | Completion callbacks fire-and-forget, no last-resort handler | `onCompleted → void this.complete()` etc., no `.catch`; no `unhandledRejection` handler anywhere; a throw mid-completion leaves `live` set so the runner reads busy forever. `orchestrator.ts:1034-1036, 1300` | Store/hub error at the wrong moment crashes the server or wedges a runner. |
| 3 | critical | Self-committed work closes the task with nothing reviewed | `commitAll` sees a clean tree → `committed:false` → no `diffStat`, worktree retired, task *done*. Guard is prompt-only; `git commit` is medium risk and the default trust level auto-approves medium. `orchestrator.ts:1273-1325` · `approval-policy.ts:65-68` · `claude.ts:1476` | Most natural agent behaviour becomes a silent no-op marked success. |
| 4 | critical | "Nothing changed" defaults to "done" | Zero-diff completion → done unless a linked brief has criteria; CLI exit 0 after an auth banner takes this path; a Claude stream ending without `result` is treated as success. `orchestrator.ts:1361-1385` · `cli-runner.ts:299-308` · `claude.ts:1980-1981` | Failures reported as completions. |
| 5 | high | Restart forgets reviews and queued merges, reuses IDs | `reviews`, `mergeApprovals`, `escalations`, merge queue, `seq` are in-memory; `seq` never re-seeded; `provision()` runs `branch -D` on an existing `agent/<runId>`. `orchestrator.ts:722-802, 2547` · `merge.ts:101` · `worktrees.ts:193-195` | Modify/Reject after restart logs "no longer resumable" while the HITL is already resolved; earlier committed work can be deleted. |
| 6 | high | Decision persisted before it is delivered | `hub.resolveHitl` writes, then `orchestrator.deliver`. `operations.ts:917 → 921` | A delivery failure loses the approval permanently. |
| 7 | high | Two blocking LLM calls inside the diff gate, no timeout | `raiseDiffReview` awaits walkthrough + merge-brief drafts. `orchestrator.ts:1573-1576` | Hung provider parks the run in *review* with no gate. |
| 8 | high | Autonomy errors logged to a nonexistent run | `tickAutonomy` appends under `runId = project.id`; store no-ops silently. `orchestrator.ts:6062` · `store/memory.ts:111-112` | Autonomous failures are invisible. |
| 9 | high | No credential parks instead of failing | Claude no-key branch sets *review* without `onFailed`; slot never freed. `claude.ts:1557-1566` | First thing a keyless user hits is a permanently busy agent. |
| 10 | high | Safety is a label | `classifyCommand` "deny" only enriches risk at raise time; firewall is a fail-open LLM consult that never blocks; sandbox/egress are opt-in, CLI-only, absent from `claude.ts`; Cursor/OpenCode/Kimi/Aider/Hermes run with vendor permissions off. `orchestrator.ts:1059-1094` · `cli-runner.ts:269-283` · `cursor.ts:73` | Five of nine runners can `git push` / `rm -rf` without hitting the classifier. |
| 11 | medium | Web store swallows every non-`ApiError` | 16 mutations catch only `ApiError`; no optimistic updates; Decisions renders "Nothing waiting." on fetch error while the badge shows a count. `store.tsx:880-1036` · `inbox.tsx:862-866, 1076-1078` | Clicks that "do nothing". |
| 12 | medium | Completion can arrive before the run is registered | `live.set` after `provider.start`; `complete()` reads `live` first → no-diff → done. `orchestrator.ts:1256 vs 2675` | Fast agents finish "successfully" without a commit. |

Genuinely fixed and worth keeping: a Claude SDK error result can no longer become a completion
(`claude.ts:1964-1969`); `RUNNER=mock` cannot leak (the env var is not read anywhere).

---

## 3. How it got here

**The merge gate never gated.**
- `main` has no protection or rulesets. PRs #701, #702, #695, #712 each merged with *build-test: FAILURE*.
- Last 30 days of CI on `main`: 31 success, 13 failure, 56 cancelled. `cancel-in-progress` on the push
  trigger means a merge burst cancels most verdicts (≈20 pushes in six minutes on 11 Sep, 14 cancelled).
- `main` did not compile 9–10 Sep (`orchestrator.ts:2893`, TS1117). Only the skipped nightly noticed.
- Four PRs in six days edited one line of `spawnWorker` (#671, #675 add `bakeoffId`; #680, #692 remove the
  duplicate): parallel agents colliding, unprotected by the product's own conflict model.

**The product definition moved; the docs did not.**
- June: fleet-supervision console as a Compose stack (README, still current). 20 Jul: "the testable loop".
  24 Jul: retarget to the local desktop app. README/CHANGELOG untouched through ~1,000 commits; only
  release is v0.1.0; the desktop-release workflow has never run.
- "Out of scope" was not enforced: hosted MFA, GCP durable sessions, public-UI mode and a hosted token
  exchange are recorded as "landed opportunistically". 29 commits to `deploy/` in 60 days.
- "Autonomous software builder" appears nowhere in the repo. Zero-touch merge rate is defined in the
  operating memo; no baseline was ever recorded.
- The roadmap is a changelog written before the change: consensus runs appear as landed, half-remaining and
  upcoming within 71 lines; 15 `[x]` items sit in a file whose header says `[x]` lives only in the archive;
  two batch tables disagree.

**The thesis was inverted.** Positioning says "wrap, don't rebuild" and "memory is the moat".

| Subsystem | Server LOC |
|---|---|
| Telegram bridge | 3,389 |
| Live preview | 2,996 |
| Steward assistant | 2,145 |
| MCP + interop | 1,748 |
| Merge engine + worktrees | 765 |
| Memory (the stated moat) | ~600 (≈10 commits) |

---

## 4. The complexity budget

| Surface | Count | Note |
|---|---|---|
| Env vars read by `config.ts` | ~90 | store/bus/sessions mandatory; the rest opt-in subsystems |
| REST routes / route files | 66 / 15 | plus ~200 client functions, 3 zod-validated |
| `contracts.ts` exports · zod fields | 285 · 616 | Project 53 fields, Task 43, TaskRun 38; 69 contract commits in 30 days |
| Server-event types | 32 | 40-case reducer in the web store; one unknown row hangs the app |
| HITL kinds | 9 | Inbox copy says four; five UI places resolve one |
| Runner adapters | 9 | Fleet copy lists five; Aider admitted unverified |
| Top views · project lenses · boards · task-page variants | 13 · 11 · 4 · 3 | ≈30 surfaces; two inboxes with one badge and different keys |
| Boot sweepers | 8 | autonomy, reaper, GC, idle-runner, rules, stall, pattern, watch |
| Server-side LLM helper calls | 35 / 7 files | two block the diff gate |
| Test files · tests · real-git loop files | 291 · 2,750 · 54 | bottom of the pyramid is real; anything with a real agent never runs automatically |
| Docs · roughly current | 25 · ~7 | 210 commits to ROADMAP.md |

---

## 5. Claims vs. code

| Claim | Rating | Reality |
|---|---|---|
| Consensus / bake-off runs | real | `startBakeoff`, `autoJudgeBakeoff`, view, 13 test files — listed as landed, half-remaining and upcoming at once |
| Prompt-injection firewall | partial | 93 lines, LLM consult, fails open, Claude-only, never blocks |
| Compliance evidence pack | real | 338 lines, signed report, export UI, tested |
| Memory v0 phases 1–2 | real (thin) | reader/writer, project view, tested; ~600 lines |
| Mass inform · manager/worker · live preview | real | wired end to end; roadmap still marks each open |
| Desktop code-signing | partial | config + secret passthrough; no certs; no release ever built |
| "5 security findings remain open" | prose stale | #665 #668 #670 #652 #678 merged 5–11 Sep |
| "Demo — mock agents" | prose only | no mock provider exists |
| "Merges it, runs the project's checks" | partial | on the hidden integration branch only; skipped in GitHub mode |
| GitHub App install picker | sample data | `MOCK_ACCOUNTS` "acme/monolith" still in the bundle, unreachable |

---

## 6. Recovery in four phases

Each phase has a checkable exit criterion. Nothing new is built until Phase 2 exits.

### Phase 0 — stop the bleeding (days)
Exit: `main` protected, green, every merge gets its own CI verdict.
- Require build-test + spa-smoke; forbid merging on red; drop `cancel-in-progress` from the push trigger;
  drop `continue-on-error` from the SPA smoke.
- Fix the two red tests (build the `contracts.test.ts` fixture from `HitlItem.parse`; add the two client
  functions to a journey/allowlist and demote `client-coverage` to a warning).
- Make the nightly honest: configure the key secret; exit 1 without it unless an explicit skip flag is set;
  boot it with a real runner.
- Rotate the MFA recovery codes; stop writing them on dev boot.
- `process.on("unhandledRejection")` + `.catch` on the three completion callbacks.
- New projects default to `autonomy: false` and a supervised approval level.
- One sentence of truth in README and roadmap header.

### Phase 1 — one honest loop (2–3 weeks)
Exit: ten consecutive real tasks on a real repo land on the base branch with tests run, proven by a
scripted run that passes on `main` daily.
- Finish the merge to base (local: fast-forward after checks; GitHub: run `checkCmd`, hold *done* until PR
  merges).
- "Done" requires a reviewed diff on base: always `diffStat` against base; zero-diff / no-result / clean
  tree → *needs attention*.
- Fail loudly on no credential; deliver before persisting the resolution; survive a restart (persist review
  and merge state, stop reusing ids, never `branch -D` unmerged work); timeouts on the gate's draft consults;
  autonomy errors to a real log.
- A deterministic demo runner as a first-class provider (what the README promises; what the smoke and
  nightly need keyless).
- A boot test through `index.ts`: real server + demo runner, assign over HTTP, approve, assert the file is on
  base.
- Run the evals weekly with a key and record pass rate.

### Phase 2 — cut to the kernel (2–3 weeks, partly parallel)
Exit: a new operator reaches a merged diff from a fresh install without docs; orchestrator < 3,000 lines with
the kernel in its own modules.
- Split `orchestrator.ts` along the kernel boundary; bake-offs, hierarchy, feature batching, GitHub PR
  management, chat, deep/auto review, budget, drive states become hub-event subscribers. Telegram, preview,
  Fly, MCP interop, Sentry behind an off-by-default plugin registry.
- Web: five nav items (Projects, Inbox, Fleet, Ready to merge, Settings); one inbox, one board, one task
  page; lenses collapse to Board / Activity / Settings; Settings gets tabs; delete `project-grouping.tsx`,
  the tweaks panel, the mock GitHub picker; QA harness out of the bundle (≈20k of 33.5k lines).
- Per-row snapshot parsing with a banner instead of a hang; one store-mutation helper that surfaces every
  error and re-throws.
- First run: connect a repo → add an agent (or demo runner) → write your first task.

### Phase 3 — become the builder (after Phase 1 exits)
Exit: zero-touch merge rate measured and rising on your own repos over four weeks, autonomy raised by the
operator.
- Steward + Plan as the front door ("I want to build X" → charter → plan → tasks).
- Autonomy as a dial the loop earns; every gate and outcome recorded.
- Zero-touch merge rate per project per week on Home.
- Then memory: decision-derived facts into the prompt with a visible "used N facts".
- Two runners, verified live, with protocol fixtures.

### What stays / what goes
**Kernel:** assign→acquire→worktree→run→complete/fail; diff/merge/verifier gates; merge engine, worktrees,
GC/reapers; hub, store, WS; Claude runner, CLI base, one verified vendor, demo runner; approval policy made
enforcing; Projects/board/task/Inbox/Ready-to-merge/Fleet/credentials/login/onboarding; `Task.version` CAS
extended to runs and HITLs.
**Extensions (default off or delete):** Telegram, Sentry, Fly, live preview; MCP/OpenAI interop, GitHub broker;
bake-offs, hierarchy, feature batching, checkpoints; deep/breaker/auto review, auto-judge, pattern/stall/watch
sweepers; seven runner adapters; Decisions inbox, Momentum/Gravity/Rail, 8 lenses, Home metrics, Audit, three
roadmap views, telemetry, agent detail, palette, tweaks, PWA, in-bundle QA, Skynet's own roadmap in nav;
hosted scaffolding. Steward and Plan stay (gated) as the Phase 3 front door.

---

## 7. Definition of usable

1. A stranger runs the loop in five minutes with no key (demo runner) and with a key (Claude) on their own
   repo, and sees the change on their base branch.
2. Every run ends in exactly one of merged / needs-attention / failed. No path marks *done* without a
   reviewed diff on base. "silently" trends to zero in commit titles (91 today).
3. A server restart loses nothing a human decided or an agent committed.
4. `main` is protected and green; the nightly runs a real agent and fails when it should; the boot test is a
   required check.
5. Zero-touch merge rate recorded for ≥10 consecutive real tasks and shown in the app.
6. README, CHANGELOG and roadmap header say the same sentence; every other doc is current, archived or
   deleted.

## 8. Operating rules

- WIP limit of three open PRs.
- Boot test + SPA smoke required on every PR; red is a stop.
- Kernel changes attach a real-repo eval run.
- Roadmap lists only the next eight items; shipped items leave in the merging PR.
- One positioning sentence, one place, quoted everywhere.
- New surfaces require the phase above's exit criterion to already hold. "Landed opportunistically" blocks
  merge.
- Dogfood: once Phase 1 exits, Skynet's own tasks run through its own supervised loop.

## Appendix — security notes

- MFA recovery codes in public history (#647 → #700, blob `d3ec63a`): rotate; decide on a history rewrite.
- Dev boot writes plaintext recovery codes to `apps/server/mfa-recovery-codes.txt`.
- Live provider keys in `skynet/.env`.
- Still open per audit: `roadmapPath`/`repoPath` containment; preview `install` commands outside the
  command-safety gate. Fly build env finding appears fixed.
- Decrypt failure falls back to the env key with only a warning (`secrets/service.ts:229-238`).
- Session token in `localStorage` remains the named follow-up.
