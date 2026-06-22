# Skynet — Roadmap

**How to read this:** Skynet ships in versions. **v0 (MVP) is the only committed scope**; later
versions are directional and will be reordered as we learn. Deep detail for big features lives in
`docs/` briefs. The principle behind every entry: **wrap, don't rebuild** — Skynet is the
management/memory/leverage layer over off-the-shelf coding agents, not an agent itself
(see [docs/positioning.md](docs/positioning.md)).

Legend: 🔬 = needs an LLM / open research · 🔗 = has a design brief · ⛓ = depends on earlier version.

---

## v0 — MVP · the testable loop  ← committed

**Goal:** an internal tester points Skynet at a repo + their Anthropic key, assigns a task, and a
**real Claude agent** does the work in an isolated sandbox under human supervision, then merges.

**Must build / resolve:**
1. **Live Claude execution** — drive Claude Code via the Agent SDK/CLI; resolve the headless auth (scrub conflicting `CLAUDE_CODE_*`/gateway env so `ANTHROPIC_API_KEY` is used).
2. **Worktree-per-runner provisioning** — each agent gets an isolated git worktree/branch.
3. **Repo connection + `.skynet/modules.json`** — a workspace points at a real repo + integration branch.
4. **Provider credential management** — per-workspace keys, injected into runners, never client-exposed.
5. **Sandboxed runner** — one container per agent (resource caps, restricted network, command allow/deny).
6. **Real-execution event fidelity** — real diffs → diff HITL, changed files → modules, branch → preview.
7. **Auth hardening to test-grade** — real login, `AUTH_REQUIRED` on, scoped CORS, rate limiting.
8. **Onboarding / first-run** — create workspace → connect repo → add key → add runner; retire seed fixtures.
9. **Deploy** — GCE VM + Docker (app + runner containers) + Cloud SQL + Memorystore + staging URL/TLS.
10. **E2E test of the loop + staging env.**

**Scope:** Claude-only · one shared hosted instance on GCP · internal testers in separate workspaces.
**Done =** the loop above runs for a tester on staging. *(~30–50 eng-days; critical path #1, #2, #5.)*

---

## v1 — Orchestration completeness & hardening
- Remaining providers live behind `runner-sdk`: **Codex, Gemini, Cursor, Copilot** — then breadth
  reactively from the candidate list in [docs/runner-catalog.md](docs/runner-catalog.md).
- **Agent labels / custom grouping** — rename agents and group them beyond project (small UX add).
- Real **live-preview** pipeline (sandboxed per-branch URLs).
- **Scale:** Redis multi-replica fan-out; GKE Jobs for runners.
- Command-safety hardening; secrets at rest; **observability** (metrics/logging/tracing).
- Auth: **SSO/OIDC**.
- 🔗⛓ **Structural agent-hierarchy hooks** — `role`, `familyOf`→root, worker→manager merge (cheap, additive; from [docs/agent-hierarchy.md](docs/agent-hierarchy.md)).

## v2 — Agentic area-managers (the hierarchy)  🔬🔗⛓
Per-project LLM **area managers** decompose an area's goal and spawn first-class **worker subagents**
via a `spawn_worker` tool; risk-based escalation; worker→manager→project merge.
[docs/agent-hierarchy.md](docs/agent-hierarchy.md)
- 🔬 The decomposition is **LLM planning** — Skynet supplies the area goal + module map + the
  `spawn_worker` tool, surfaces a `plan` HITL, and spawns workers on approval. The model does the "how."
- **Managers organize by area *or* role** — same mechanism, different scope: a "Billing manager"
  (module area) or a "Review / QA / Security manager" (function). Role-managers are how specialized
  agents are arranged; workers under them inherit the role's prompt + tool scope.

## v3 — Triggers & integrations (inbound work)  🔗
Turn Skynet from "I assign tasks" into "work flows in from my stack, human-gated." Every integration
uses the **user's own accounts** (their Sentry, GitHub, LLM key) — Skynet is the connective +
supervision layer, it doesn't host or resell those services.
- **The enabling primitive:** an **inbound-trigger** concept — a webhook/event creates a task or agent
  in a workspace. Today the only trigger is "operator assigns a task"; this one primitive unlocks the
  whole category. (Cheap to design early so we don't foreclose it; build here.)
- **Tools via MCP:** an agent gets scoped tools (GitHub / Sentry / Slack MCP) to act back into the
  user's services. A "Sentry agent" = a coding agent + Sentry MCP + a Sentry webhook trigger.
- **Candidate responders:** Sentry regression → fix PR · GitHub issue → PR · PR review · CI-failure
  fix · Dependabot/CVE patch+fix · PagerDuty/Datadog incident triage · support ticket → bug task.
- Tier-2 API agents (Devin, Jules — see runner-catalog) plug in here as delegated remote workers.

## v4 — Moat Layer: Portable cross-vendor memory (M1)  🔗
User-owned memory that no single vendor can match, because everything streams through Skynet.
[docs/positioning.md](docs/positioning.md) §3.2
- Cross-vendor, long-lived, **portable/exportable**, scoped (workspace / project / area / family).
- **Manage repo-native memory too:** read/write/sync **`CLAUDE.md`, `.cursor/rules`, Copilot
  instructions, etc.**, and project Skynet's portable memory into each vendor's native format.
- Injection via the vendor-agnostic `runner-sdk`; sourced from the streams + `hitl_audit` already
  flowing through the `hub`.
- 🔬 **LLM-assisted distillation** of good memory from history — open research; start with
  operator-authored + decision-derived facts, add a Skynet-side curating LLM later.

## v5 — Moat Layer: Agent fluency (M2)  🔬🔗
Help users run **more agents with clearer tasks** — the flywheel (better results + more usage).
[docs/positioning.md](docs/positioning.md) §3.3
- **Task linter** (split/clarify suggestions), **parallelism nudges**, and an **outcome feedback loop**
  (which task phrasings one-shot cleanly vs. churn through HITL).
- 🔬 The coach is **LLM-based** (critiques tasks, proposes decompositions); open research on UX + quality.
- Compounds with v4 — the coach learns from the workspace's own memory/history.

## v6 — Vendor migration
Help a user **move from one vendor to another** (Claude ↔ Codex ↔ Gemini …): carry over the
vendor-neutral memory, translate config/rules, and re-home in-flight work — leveraging the portable
memory (v4) + thin runner adapters.

---

## Considerations / open questions (decide later)
- 🔬 **LLMs for memory distillation (v4) and the fluency coach (v5)** — both likely require an LLM;
  decide model / cost / UX. (Flagged by design, not avoidance.)
- **Repo-optional / chat-only mode** — a repo should *not* be hard-required. A "just chat with an
  agent" mode is mechanically a runner with **no worktree and no merge**; it widens the funnel to try
  Skynet. Not the core money bet, but cheap to allow.
- **Distribution:** hosted (our GCP) vs. self-host (`docker compose`) vs. **BYO-runner** (containers on
  the customer's infra, only the UI hosted) for code-privacy.
- **Retention/policy** for logs, audit, and memory.

## Parked / explicitly out
- **Building our own coding agent** — never. Wrap, don't rebuild ([docs/positioning.md](docs/positioning.md)).
- Older Tower explorations live in `../Project Skynet DRAFT/` (reference only).
