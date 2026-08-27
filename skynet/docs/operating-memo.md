# Skynet — Product Operating Memo

**Date:** 2026-08-20  
**Status:** living document — updated each planning cycle

---

## 1. North-star

**Every operator's fleet ships more each week than it did the week before — with less of their
own time.**

The measurable proxy is the **zero-touch merge rate**: the fraction of tasks that travel from
backlog to merged diff without the operator doing anything except "Approve." When that number
rises week-over-week for a cohort of operators, Skynet is working. When it stalls, something in
the loop — governance, memory, task quality, agent capability — is the bottleneck, and that is
where investment goes next.

This metric is intentionally output-agnostic: it captures throughput, trust, and product-market
fit in one number, and it compounds — a higher zero-touch rate means more tasks complete per
operator-hour, which drives retention, which drives data for memory, which raises the rate
further.

---

## 2. Ideal Customer Profile (ICP)

**Primary:** A software engineer or small engineering team (1–8 people) that already uses Claude
Code, Copilot, or another coding agent for solo tasks, and is **capacity-constrained** — more
backlog than time. They know how to write clear task descriptions. They are comfortable with
Git. They want to run several agent instances at once but do not trust autonomous action without
a lightweight oversight layer.

**Behavioral signals that mark an ICP user:**
- Has tried letting an AI agent work for >30 min unattended and gotten burned at least once
- Has a backlog of tasks they can describe clearly but haven't started due to bandwidth
- Uses at least one coding agent today (Claude/Copilot/Codex)
- Can name at least one "area" of their codebase they would not want an agent touching without review

**Secondary (later):** Engineering leads at growth-stage startups managing AI-assisted squads
where policy, audit, and delegated approval matter — the governance wedge. This buyer is 6–12
months behind the primary ICP in terms of readiness, but they are the ones who pay for
compliance evidence, SIEM export, and SSO.

**Explicitly not yet in scope:** Non-technical teams, product managers running AI, enterprise IT,
or anyone who cannot read a diff and decide whether to approve it.

---

## 3. ICP Hypotheses (test before scaling)

These are beliefs that must hold for the business to work. Each has a falsifiable test.

| # | Hypothesis | Falsified if |
|---|---|---|
| H1 | AI-forward devs will run **multiple agent tasks in parallel** once supervision is easy enough | Median operator runs ≤1 concurrent task after 2 weeks |
| H2 | The governance layer (HITL Inbox, safety classifier, audit) is the **missing piece** that makes operators comfortable raising autonomy | Operators leave autonomy off even after 10+ resolved gates |
| H3 | **Cross-vendor portability** is a real need — operators want to mix Claude + Codex + another | <20% of active operators configure more than one runner after 30 days |
| H4 | **Accumulated context** (memory, decisions, patterns) compounds into a switching cost within 30 days | Day-30 WAO is not materially higher than Day-7 WAO for the same cohort |
| H5 | The **local desktop app** is the right launch form factor — operators want BYO-key, local data | <30% of installs connect a real repo + key within 7 days of install |

Track H1 and H2 from day one; H3–H5 require at least 50 active installs to read reliably.

---

## 4. Core Problems We Solve

These are the problems the ICP hits TODAY, before Skynet:

**P1 — Agents stall and wait.** A coding agent that needs a decision sits idle until the
developer checks in. A developer who is away for 2 hours loses 2 agent-hours. The HITL Inbox
with push notifications solves this: the operator sees the pause, resolves it from their phone,
the agent continues.

**P2 — No fleet-level oversight.** Running two agents at once in two terminals is chaos —
conflicts, overlapping edits, no shared context. The fleet board, conflict families, and module
map solve this: the operator sees the whole board and Skynet prevents two agents from fighting
over the same files.

**P3 — Trust is binary.** Either you watch every command (slow) or you run agents fully
unattended (risky). The governance layer (safety classifier, blast-radius flags, approval
policies, autonomy circuit-breaker) enables **graduated trust** — operators can raise autonomy
incrementally without losing oversight.

**P4 — Nothing carries forward.** Every new conversation starts from scratch. The HITL audit,
decisions, patterns — none of it informs the next task. Memory (in progress) solves this; it is
the moat, but it requires real usage to build.

**P5 — Auditability is absent.** "An AI made this change" is not enough for a PR review, a
compliance check, or a team post-mortem. The tamper-evident audit trail and compliance evidence
pack solve this specifically.

---

## 5. Primary KPIs

### North-star KPI
- **Zero-touch merge rate (ZTMR)** — tasks merged with no operator action beyond an "Approve"
  click, as a fraction of all tasks merged. Target: rising week-over-week for active cohorts.
  Baseline: measure from first 20 real-repo merges.

### Health KPIs (weekly)
| KPI | What it signals | Alarm threshold |
|---|---|---|
| Weekly active operators (WAO) | Top-line product health | Flat for 2 consecutive weeks |
| Tasks merged per WAO per week | Fleet throughput per operator | <3 after week 2 for a cohort |
| Day-7 retention | PMF signal | <40% |
| Median HITL resolution time | Friction in the oversight loop | >30 min median |
| Autonomy-on rate | Trust in governance | <20% of projects after 10 merged tasks |

### Moat KPIs (monthly, once memory is live)
| KPI | What it signals |
|---|---|
| Memory facts per operator (accumulation rate) | Data moat growing |
| One-shot rate delta (month-over-month) | Memory compounding into better results |
| Cross-vendor usage rate | Portability lock-in working |

### What we explicitly do NOT optimize for right now
- Total installs (vanity until retention is proven)
- Revenue (pre-PMF; don't gate growth on a paywall yet)
- Feature count (depth beats breadth until WAO>100)

---

## 6. Decision Cadence

### Weekly (every Monday)
- Review KPI dashboard (ZTMR, WAO, merged tasks/operator, HITL resolution time)
- Assign the current batch of tasks from the backlog — one batch per week, size ≤8 items
- Triage any issues or escalations that landed in the week
- One decision: does anything in flight need to be deprioritized or stopped?

### Every two weeks (sprint boundary)
- Review batch outcomes: what was completed, what slipped, why
- Re-rank the backlog for the next sprint based on PMF signal, not roadmap order
- One shared read: user feedback / install analytics / HITL audit patterns

### Monthly
- Review active hypotheses (§3) — are H1–H5 confirmed, refuted, or still unclear?
- Decide whether to move ICP or stay the course
- Review roadmap prioritization across the four tracks (§7) — adjust allocations

### Quarterly
- North-star review: is ZTMR the right metric? Is it rising?
- One big bet: what is the single highest-leverage thing for the next quarter?
- Competitor scan: has anything shifted in the agent landscape that changes the moat thesis?

### Decision authority
- **Operator (human, weekly):** batch assignment, any scope expansion beyond the spec
- **Skynet (autonomous):** implementation choices, file-level decisions within a task's spec
- **Escalation trigger:** any task that touches `packages/shared` contracts, pricing/monetization,
  ICP definition, or the north-star metric — these are human decisions, not agent decisions

---

## 7. Roadmap Prioritization — Four Tracks

Every item in the backlog belongs to one of four tracks. At any given time, the allocation
across tracks reflects where we are in the PMF journey.

### Track definitions

| Track | Question it answers | Examples |
|---|---|---|
| **PMF** | Does the core loop work and retain real users? | First-run experience, HITL latency, zero-touch reliability, autonomy trust |
| **Platform** | What infrastructure makes the moat durable? | Memory v0, cross-vendor seam, audit chain, open memory format |
| **Product** | What features do ICP users ask for or churn without? | Task sync, live preview, compliance pack, code signing |
| **GTM** | How do operators find and adopt Skynet? | Onboarding polish, desktop distribution, documentation, landing page |

### Current allocation (August 2026 — pre-launch, ≤50 installs)

```
PMF      ████████████░░░░  50%   ← primary focus: does the loop work?
Platform ████████░░░░░░░░  30%   ← memory hooks, cross-vendor seam (moat seeds)
Product  ████░░░░░░░░░░░░  15%   ← things users explicitly ask for
GTM      ██░░░░░░░░░░░░░░   5%   ← just enough to be installable and findable
```

**Transition rule:** when Day-7 retention exceeds 40% AND WAO is growing, shift 10% from PMF
into GTM (start driving installs). When a moat hypothesis (H3 or H4) is confirmed, shift 10%
from Product into Platform.

### Batch prioritization rule

Within a batch, items are ranked by this order:

1. **Blocker** — anything that prevents a real user from completing the core loop (assign →
   merge) on their own machine. Fix before anything else.
2. **PMF signal** — anything that will tell us within two weeks whether a hypothesis is true
   or false. Prioritize because it shortens the learning cycle.
3. **Moat seed** — anything that builds an asset (audit data, memory raw material, cross-vendor
   usage) that compounds with time. Earlier is better; these don't show in short-term KPIs.
4. **User-requested** — features explicitly requested by active operators. Weight by retention
   impact, not by how often they're asked.
5. **Nice to have** — everything else.

### What does NOT get prioritized until PMF is clearer
- Hosted / multi-tenant (🏢) — explicitly deferred; no multi-user before the single-operator
  loop is proven
- Enterprise features (SSO, SIEM, team roles) — secondary ICP
- Agent-fluency layer (area managers, task linter, parallelism nudges) — v2+; the loop must
  first be reliable before the optimization layer is valuable

---

## 8. Upcoming Batch Prioritization

The following is the recommended priority order for the next 3 batches, derived from the
framework in §7. Items are ranked PMF > Platform > Product within each batch.

### Batch N (current focus)

| # | Item | Track | Rationale |
|---|---|---|---|
| 1 | Deep-review UI toggle + settings panel | PMF | `deepReview`/`breakerReview` are API-only today; operators need to enable them without `curl` |
| 2 | Memory v0 — operator-authored facts, injected per project | Platform | Earliest moat seed; raw material already accumulating via `hitl_audit`; visible to users |
| 3 | Reactive runner breadth (Kimi Code landed) | Product | Completes the multi-vendor seam; unlocks H3 validation |
| 4 | First-run onboarding telemetry (anonymous install events) | PMF | Without install funnel data, H5 cannot be tested; blocking hypothesis validation |
| 5 | `Mass inform` — Fleet/Project UI (multi-select + whole-project) | Product | Plumbing shipped; UI missing; real user request for coordinating agents mid-sprint |

### Batch N+1 (next sprint)

| # | Item | Track | Rationale |
|---|---|---|---|
| 1 | Memory v0 — decision-derived fact capture from `hitl_audit` | Platform | Converts existing audit trail into the first auto-accumulating memory corpus |
| 2 | Desktop code-signing (macOS + Windows) | GTM | Removes the right-click-to-open friction that kills conversion for non-technical evaluators |
| 3 | Cross-vendor consensus runs (same task, two agents, auto-diff) | Platform | First-of-kind differentiator; confirms H3 when adoption data arrives |
| 4 | `deepReview` + `breakerReview` project settings UI | PMF | Makes the two-lens review loop operator-accessible without API calls |
| 5 | Preview Phase 2 — service-container runtime + auto-rebuild on merge | Product | Closes the gap between "web/SPA preview" and "any software" |

### Batch N+2 (directional — reprioritize after N+1 retrospective)

| # | Item | Track | Rationale |
|---|---|---|---|
| 1 | Memory v0 — workspace-scoped MCP read/write server | Platform | Opens the memory as an interoperability surface; first step toward the open format |
| 2 | Autonomy telemetry dashboard (ZTMR, HITL volume, resolution time) | PMF | Operators need to see their own fleet improving to form habit; also gives us the KPI data |
| 3 | Approve-with-rule batch mode (similar gates, one decision) | PMF | Reduces HITL friction for repeat patterns; directly raises ZTMR |
| 4 | `Per-project live preview` — Phase 3 (command/CLI/artifacts) | Product | Completes "any software" preview coverage |
| 5 | Plan entity + project view panel (Product Steward foundation) | Platform | Durable roadmap primitive; also feeds the steward agent when that work begins |

---

## 9. Operating Principles

1. **Wrap, don't rebuild.** Skynet is the management layer, not the agent. Never build what a
   vendor agent does better. Every LLM-powered helper Skynet adds (memory distillation, task
   critique, auto-review) is orchestration, not agent internals.

2. **Governance is the launch wedge.** The safety layer, HITL Inbox, and decision audit are
   the competitive white space. They are not a compromise with autonomy — they are what makes
   autonomy trustworthy enough to turn on.

3. **Ship staggered, not "orchestration then moat."** The memory moat only compounds after users
   run agents through Skynet. We don't wait. We launch on governance, capture raw material from
   the first run, and pull a thin Memory v0 forward before we have scale.

4. **Measure twice, build once.** Before building a feature, name the KPI it moves and the
   hypothesis it tests. If neither is clear, the feature is not yet prioritized.

5. **The local desktop app is the release.** Hosted / multi-tenant is explicitly deferred.
   Every build decision optimizes for the single-operator, BYO-key, local-first experience until
   that form factor has proven retention.

6. **Open memory strengthens the moat.** Counter-intuitively, locking in the memory format is
   weaker than publishing an open format and an MCP server. Users trust what they can't be
   locked out of. The moat comes from curation quality, the accumulated corpus, and being the
   hub — not from owning a proprietary format.

---

*This memo is owned by the product operator. Update the batch tables each sprint after
the retrospective. Update §5 (KPIs) when new instrumentation lands. Update §3 (hypotheses)
when a hypothesis is confirmed or refuted.*
