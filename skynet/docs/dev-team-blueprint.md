# Skynet — Auto Dev Team: the per-project team blueprint

> **Status:** vision sketch (for discussion — nothing here is committed scope).
> **The ambition:** creating a project doesn't give you *an agent* — it gives you a **whole
> dev team**: roles, review chain, security, docs, and process, assembled automatically and
> supervised through the same gates that exist today. The operator hires a team with one
> approval, then only sees what escalates.
>
> Builds directly on [agent-hierarchy.md](agent-hierarchy.md) (managers/workers — ratified),
> the governance layer (HITL kinds, safety classifier, audit), [subway-model.md](subway-model.md),
> and [positioning.md](positioning.md). **Wrap, don't rebuild** applies to people too: a "role"
> is not a new agent type — it's the same agent primitive with a role prompt, a tool scope,
> and an escalation policy. One mechanism, many hats.

---

## 1. The core idea: Charter → Blueprint → Plan

A team can only be sized from a **proper understanding of the project** — so intake comes
first. Creating a project is a short, LLM-assisted conversation, not a name field:

```
"I want usage-based billing"        ← the operator's raw ask
        │
        ▼  intake interview (LLM drafts, operator corrects — G-1)
┌─ PROJECT CHARTER ───────────────────────────────────────────────────────┐
│  Goals & non-goals · definition of done · constraints (stack, deadline, │
│  budget) · known risks & unknowns · success criteria. Draft-quality in  │
│  seconds; the operator edits/approves. Stored on the project + memory.  │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼  + repo profile (size, stack, module map, backlog depth)
┌─ TEAM BLUEPRINT (a `plan` HITL — Gate G0) ──────────────────────────────┐
│  Roles to hire, how many, which provider/model per role, which gates    │
│  are active, budgets, and the escalation policy.                        │
│  Operator: approve / edit / strip down to a single dev.                 │
└──────────────────────────────────────────────────────────────────────────┘
        │ approve
        ▼
┌─ INITIAL PLAN (a `plan` HITL — the CoS's first act) ────────────────────┐
│  Proposed epics → milestones → tasks (each with a short name + full     │
│  brief + acceptance criteria), dependency order, and per-milestone      │
│  effort/budget estimates. Operator approves/edits → becomes the backlog.│
└──────────────────────────────────────────────────────────────────────────┘
        │
Team provisioned → work flows through the pipeline (§4) → team scales
elastically with the backlog → roles retire when idle → project ships.
```

- **The Charter is the source of truth** the whole team plans against — the Architect reads
  its constraints, the Spec Analyst checks briefs against its definition of done, the CoS
  reports progress against its milestones. It lives on the project *and* in memory (v4), so
  later agents — and later *projects* — inherit it.
- **On timing:** agent work is wall-clock-fast, so "timing" here means **dependency order,
  milestone sequencing, and human-gate availability** — not sprint dates. Estimates are
  honest ranges (tokens/cost + elapsed-time), refined by the retro loop's actuals (§4), never
  fabricated deadlines.
- The blueprint is **sized to the charter**: a README fix proposes one developer and no
  ceremony; a payments service proposes the full bench. The operator can always edit —
  charter, blueprint, and plan are *defaults*, not mandates.

### Whose keys, whose models (decided)
**The user's own keys — everywhere.** The intake interviewer, the blueprint proposer, the CoS
planner, and every role agent all resolve credentials through the existing per-workspace
secret store (`secretService.resolve`) exactly like runners do today. This is
[positioning.md](positioning.md) applied to orchestration: Skynet is the supervision layer, it
does **not** host or resell model access. Consequences, made explicit:
- **BYOK end-to-end** — no Skynet-side model account, no markup, works offline-from-us.
- **Metered like everything else** — charter/blueprint/planning calls are token-metered under
  the project budget and show up in the CoS digest (planning isn't free, so it's visible).
- **Role→model choice is the user's** — the blueprint proposes a model per role (cheap model
  for the Scribe, strong model for the Architect); the operator's keys determine what's
  available, and the picker only offers providers with a stored credential.
- **A project with no key can't hire** — intake still works up to the charter draft (one
  cheap call), then prompts to connect a provider (the v1 guided-connect flow).

---

## 2. The roles (one primitive, many hats)

Every role = `Agent { role, scopePrompt, toolScope, escalationPolicy, budget }` on the
existing runner seam. Any provider can fill any role (Claude lead + Codex devs + Gemini
reviewer is a *feature* — diverse-lens review is one of our signature bets).

| # | Role | Mandate (what it does) | Never does | Key gates it drives |
|---|---|---|---|---|
| 1 | **Chief of Staff** (one per project) | Drafts the **initial plan** (epics → milestones → tasks, dependency-ordered, with estimate ranges) from the Charter; owns the backlog; assigns to leads; posts the daily digest (shipped/blocked/cost, progress vs. milestones); proposes team scaling | Edit code | G0 blueprint, initial plan, standup digest |
| 2 | **Spec Analyst** (PM hat) | Runs the **intake interview** (drafts the Project Charter — goals, non-goals, risks, done-definition — for the operator to correct); turns vague asks into task briefs — short name + full description + acceptance criteria (the task-linter, §v1.5, as an agent); asks clarifying `question`s *before* work starts | Edit code | G-1 charter, G1 spec gate |
| 3 | **Architect** | Owns the module map; writes ADRs (→ memory); reviews leads' plans for cross-area fit; flags boundary violations | Edit code (advises only) | G2 plan gate (consulted) |
| 4 | **Area Leads** (per module area) | Exactly [agent-hierarchy.md](agent-hierarchy.md): decompose area goals, `spawn_worker`, first-line supervision by risk policy, first-line diff review, worker→area merges | Broad edits outside area | G2, first-pass G4 |
| 5 | **Developers** (workers, N elastic) | The coding agents — one task each, own worktree/branch, any provider | Merge their own work | raise G3/G4 |
| 6 | **QA / Reviewer** (function lead) | Agent-authored diff walkthroughs; writes/runs tests; enforces the **verifier gate** (tests green before human review); can bounce work back with guidance (the existing `modify` loop) | Approve merges (humans do) | G4 review gate |
| 7 | **Security Officer** | Scans diffs for secrets/injection/dep risks; watches every safety-classifier flag; hard-blocks on findings (escalates high) | Auto-approve anything | G5 security gate |
| 8 | **Docs & Release Scribe** | Updates docs/changelog per merged change; drafts release notes; keeps README honest | Gate other work | G7 release gate (input) |
| 9 | **Memory Curator** (librarian) | Distills `hitl_audit` decisions + retro outcomes into portable memory facts; promotes approve-with-memory items; syncs repo-native files (CLAUDE.md, .cursor/rules) | Edit product code | feeds §6 learn loop |
| 10 | **SRE / Ops** *(later — needs v3 inbound triggers)* | Watches CI/incidents/alerts; files fix tasks with context; routes failures back to the originating run | Deploy without gate | inbound intake |

Small-project degenerate case: **roles collapse, the pipeline stays.** One developer can wear
every hat (the gates still run — spec check, verifier, review — just without dedicated agents).
That keeps tiny projects cheap while the *process* is uniform.

---

## 3. Toll gates (the process spine)

Gates are the existing HITL kinds + policy-as-code. **Default: humans hold every gate**; the
blueprint's escalation policy *delegates* specific gates to specific roles, and every delegated
decision is written to `hitl_audit` as `manager:<id>` (already designed) — reviewable, revocable.

| Gate | What's checked | Default holder | Delegatable to |
|---|---|---|---|
| **G-1 · Charter** | Project goals, non-goals, risks, done-definition (LLM-drafted, human-owned) | **Human** | never |
| **G0 · Blueprint** | Team composition, budgets, policy | **Human** | never |
| **G1 · Spec** | Task has a name, brief, acceptance criteria | Spec Analyst (auto) → `question` to human if ambiguous | — |
| **G2 · Plan** | Worker's plan before any writes (plan-mode) | Area Lead (low-risk) / **Human** (medium+, cross-area → Architect consulted) | lead |
| **G3 · Command** | Safety classifier on shell/tool actions | **Human** (medium/high); denylist hard-blocks regardless | never above low |
| **G4 · Review** | QA walkthrough + verifier (tests green) → diff review | QA pre-chews; **Human approves** | lead/QA for low-risk areas, by policy |
| **G5 · Security** | Secrets, injection, dependency risk on the diff | Security Officer; findings → **Human** | never on findings |
| **G6 · Merge** | Serialized queue; conflicts | Auto when clean; conflicts → **Human** | — |
| **G7 · Release** | Docs updated, changelog drafted, ship decision | **Human** | never |

Two invariants, non-negotiable:
- **The blueprint can loosen *who* holds a gate, never *whether* the gate exists.**
- **Nothing self-approves.** A role never resolves a gate on its own work (the QA agent doesn't
  review its own test changes; a lead doesn't approve its own plan). Enforced structurally, not
  by prompt.

---

## 4. The pipeline (how work flows)

```
 charter ─ intake interview → Charter ─────────────────[G-1, once per project]
   │
 plan₀ ─── CoS: epics → milestones → tasks + estimates ─[initial plan, once]
   │
 intake ─ CoS triages new asks (or v3 trigger files it)
   │
 spec ──── Spec Analyst → brief + acceptance criteria ──[G1]
   │
 plan ──── Lead/worker plan-mode → Architect consult ──[G2]
   │
 build ─── Developer edits in isolated worktree ───────[G3 per risky command]
   │
 verify ── QA runs tests; red → bounce back (modify loop)
   │
 review ── QA walkthrough → human diff review ─────────[G4]
   │
 secure ── Security scan on the approved diff ─────────[G5]
   │
 merge ─── Serialized queue → integration branch ──────[G6]
   │
 document─ Scribe updates docs/changelog
   │
 learn ─── Curator distills decisions → memory; retro metrics
   │
 ship ─────────────────────────────────────────────────[G7]
```

**Supporting processes:**
- **Standup digest** — the CoS posts a daily (or per-session) summary: shipped, in-flight,
  blocked-on-you, spend vs. budget. Rides the existing report/mass-inform seam; no extra turns.
- **Escalation ladder** — worker → lead → CoS → operator, with **SLAs on gates** (waiting-time
  is already tracked; a gate breaching its SLA pings the digest / notification).
- **Retro loop** — after each epic: which briefs one-shotted vs. churned through gates → the
  provably-improving-fleet metrics (ROADMAP ⭐4); the Curator promotes winning patterns to memory;
  **estimate calibration** — actual tokens/time per task feed back into the CoS's ranges, so
  milestone estimates get honest with use instead of staying guesses.
- **Elasticity** — the CoS proposes scaling ("backlog 12 deep, 2 idle runners → hire 3 devs?")
  as a `plan` gate; roles idle past a TTL auto-retire (their memory persists — the team is
  disposable, the knowledge isn't).
- **Cost governance** — per-role and per-project token budgets in policy-as-code; the CoS digest
  reports burn; hard caps pause hiring, never bypass gates.

---

## 5. What the operator experiences

- **One decision to start:** approve the blueprint (G0). Edit it freely — strip to one dev, or
  go full bench.
- **An Inbox that shrank:** only escalations arrive (a delegated-gate filter shows everything
  the team handled, with reasons — the audit trail keeps machines honest).
- **The subway shows the team:** leads as tracks with worker branches (already renders);
  role-function agents (QA, Security) as tracks that touch every station they review — plus a
  **team page**: the org chart, each role's mandate, budget burn, and delegation policy.
- **Chat with any role** — ask the CoS "why is the payments epic slow?", ask the Architect
  "why this pattern?" (its ADRs are in memory).

---

## 6. Why this is defensible (ties to the moat)

1. **Governance compounds** — competitors fan out workers; none run a *supervised process*
   (gates, audit, no-self-approval). The team blueprint is governance productized: the wedge,
   scaled up.
2. **Memory compounds** — every role reads/writes the portable memory (v4): the Architect's
   ADRs, the Curator's distilled decisions, the retro's winning task-phrasings. A team that
   *remembers* across projects and vendors is the second brain with an org chart.
3. **Cross-vendor is structural** — Claude lead, Codex devs, Gemini reviewer. Diverse-lens
   review (⭐ consensus runs) becomes just… how the QA role works.
4. **The fluency flywheel** (v5) gets an owner — the Spec Analyst *is* the task linter; the
   CoS *is* the parallelism nudge; the retro *is* the outcome feedback loop.

## 7. Honest risks & mitigations

| Risk | Mitigation |
|---|---|
| **Token burn multiplies** (10 roles ≥ 10× a solo agent) | Roles are **on-demand, not standing** — no idle meetings; consult-style short calls (`consult`, not full runs); per-role budgets; degenerate single-dev mode for small projects |
| **Rubber-stamp managers** (delegated gates approve everything) | Conservative default policy; sampled human audit of delegated decisions; diverse-lens verify on review; delegation is per-gate revocable |
| **Latency** (pipeline adds hops) | Gates G1/G2/G5 are seconds-cheap consults; only build/verify are long; parallel across tasks as today |
| **Complexity** (org-chart cosplay) | Roles collapse by default; the blueprint proposes the *smallest* team that fits; process > headcount |
| **Prompt-injected role** (a poisoned diff steers the QA agent) | The prompt-injection firewall (ROADMAP ⭐3) guards role agents exactly like workers; no-self-approval bounds blast radius |

## 8. Sequencing (maps onto the roadmap, no new epochs)

- **Phase A — rides v2 (area managers):** CoS-lite (decompose + assign + digest) + Area Leads
  (the ratified brief) + **QA role** (walkthrough + verifier gate — both already roadmap items).
  Blueprint v0 = "how many leads/devs + QA on/off".
- **Phase B — rides v1 governance + v3 triggers:** Security Officer (policy-as-code + classifier
  hooks), Spec Analyst (task-linter as agent), Scribe; SRE once inbound triggers land.
- **Phase C — rides v4/v5 (the moat):** Memory Curator, retro loop → provably-improving fleet,
  elastic scaling, cross-project team memory.

Everything reuses: `role`/`parentId` (exists), `spawn_worker` (v2), HITL kinds (exist), risk
policy + audit-as-`manager:<id>` (designed), policy-as-code (v1), memory (v4). **No new
subsystem — the team is the existing machine, staffed.**
