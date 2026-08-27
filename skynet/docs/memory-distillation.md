# Research: LLM-assisted distillation of good memory from history

> **Status:** Open research writeup — no memory store or distillation pipeline shipped.
> **Scope:** ROADMAP v4, "🔬 LLM-assisted distillation of good memory from history — open
> research; start with operator-authored + decision-derived facts, add a Skynet-side curating
> LLM later." See [docs/positioning.md](docs/positioning.md) §3 (Layer 2) for why this is the
> strongest moat, and [docs/operating-memo.md](docs/operating-memo.md) §8 for sequencing.

---

## 1. The question being answered

Skynet already has raw material — the `hub` sees every stream and `hitl_audit` captures every
human decision ("decided X because Y") — but no store, no curation, and no injection path yet.
Memory v0 (pulled forward to v1.5) covers the **non-LLM** half: operator-authored facts +
mechanical decision-derived capture (the `approve-with-memory` note on a `Resolution`). This
writeup answers the harder half: **once raw facts exist, how does an LLM turn them into memory
worth trusting** — without fabricating facts, without an unbounded LLM bill, and without
building something a human has to babysit forever?

This is explicitly a research spike, not an implementation plan: the honest caveat in
positioning.md is "auto-distilling good memory is hard." The goal here is to de-risk the design
before committing engineering time — pick the pipeline shape, the guardrails, and the phase
boundary where an LLM gets involved.

---

## 2. What already exists (the substrate this builds on)

| Piece | Where | State |
|---|---|---|
| Decision corpus | `hitl_audit` (`Store.recordAudit`, `apps/server/src/operations.ts:588-620`, `hub.ts:183-215`) | **Shipped.** Every HITL resolution — action, guidance, chosen option, the gate's own rationale/risk/diff — is written as a self-contained audit record, workspace-scoped. |
| Manual "remember this" capture | `Resolution.memoryNote` (`packages/shared/src/contracts.ts:1352`), the Inbox's "+ Also remember" toggle (`apps/web/src/views/queue.tsx:321`) | **Shipped as capture only.** The note rides into the audit payload (`memoryNote`, `operations.ts:605`) and renders in the Audit view ("📝 Remembered: …", `audit.tsx:192-195`). **Nothing reads it back out or injects it anywhere yet** — it's a labeled breadcrumb in the audit trail, not a memory store. |
| Structured `MemoryFact` entity | — | **Does not exist.** No shape in `contracts.ts`, no store adapter, no scoping (workspace/project/area/agent). This is the Memory v0 gap that has to land before distillation has anything to write *into*. |
| Injection seam | `project.instructions` prepended to the task brief (`orchestrator.ts:4500,4575,4751`); `CLAUDE.md` / `settingSources` load for the Claude runner (`packages/runner-sdk/src/claude.ts:482,1122`) | **Partially shipped, not memory-aware.** The vendor-agnostic seam positioning.md promises already exists for one thing (free-text project instructions) — this is where distilled memory facts would get rendered in, per vendor, later. |
| Stateless LLM "consult" pattern | Auto-review verdict, agent-authored diff walkthrough (`orchestrator.ts`, see `docs/positioning.md` "consult") | **Shipped, reusable.** A structured-JSON, single-shot call to a model that never touches the agent's own tool loop — the exact shape a curating LLM should take (see §5).

**Net:** the corpus (`hitl_audit`) and the capture UX (`memoryNote`) exist; the store, the scoping,
the injection-of-facts, and any distillation are all still ahead. This research assumes Memory v0
(the `MemoryFact` store + operator-authored/decision-derived, non-LLM baseline) lands first —
distillation has nothing to curate into otherwise.

---

## 3. What counts as "good" memory

Not every audit record or note is worth promoting. A useful taxonomy, ordered by how much
judgment it takes to extract correctly:

1. **Operator-authored fact** — typed directly (`memoryNote`, or a future "add a memory" action).
   No extraction needed; the risk is scope creep (a fact typed for one task read as universal).
2. **Decision-derived preference** — "reject: use snake_case for Python files" said once should
   generalize to "this project prefers snake_case for Python" without the operator re-typing it
   every time. This is pattern extraction across *multiple* similar decisions, not one.
3. **Decision-derived constraint** — a `reject`/`modify` guidance that encodes a hard rule
   ("never touch `billing/` without a migration plan"). High value, but easy to over-generalize
   from a single incident.
4. **Rationale / gotcha** — the *why* behind an approval ("approved because the flaky test is
   already tracked in #482, not related") — valuable as context, actively harmful if promoted as
   a standing rule.

Only (1) is safe to store verbatim today. (2)–(4) require judgment about generalization scope,
which is exactly the part an LLM can help with and exactly the part that can hallucinate a rule
nobody actually meant. This taxonomy is the thing any distillation prompt has to be told about
explicitly — "extract a fact" is underspecified; "extract a *scoped, falsifiable* fact and say
which category it is" is not.

---

## 4. Proposed pipeline shape

```
hitl_audit records ──▶ candidate extraction (batched, offline) ──▶ curating LLM ──▶
   dedup / contradiction check against existing MemoryFacts ──▶ human-confirm queue ──▶
   promoted MemoryFact (scoped, provenance-linked)
```

### 4.1 Candidate extraction — batched, not per-event

Running an LLM per HITL resolution is both wasteful (most approvals carry no generalizable
signal — "approve" with no note is not a fact) and dangerous (an LLM incentivized to always find
something will invent something). Extraction should be a **periodic batch job** (nightly, or
"on demand from a project settings button" for v1) that:

- Pulls `hitl_audit` records since the last run for a workspace/project, filtered to
  `reject`/`modify` resolutions (explicit correction — the strongest signal), `memoryNote`-tagged
  approvals (explicit operator intent), and repeated `reject` patterns on the same
  gate `kind`/`command` shape (the "said it three times" signal for un-tagged decisions).
- Hands the curating LLM a **small, bounded batch** (the audit records plus their own
  self-contained rationale/diff — no repo access, no tool use) — never the full history at once.

### 4.2 The curating LLM — a consult, not an agent

This must be the same shape as the existing auto-review verdict / diff walkthrough: a **stateless,
structured-JSON call**, not a tool-using agent. Per positioning.md's line-not-to-cross ("LLM-powered
helpers we add — memory distillation, task critique — are fine; they are not us re-implementing an
agent"), the curator:

- Reads a batch of audit records (+ optionally the diff/rationale already captured on them).
- Returns a list of **candidate facts**, each with: `text` (the fact, phrased as a falsifiable
  statement, not an instruction), `category` (§3's taxonomy), `scope` (workspace / project / area
  / agent-family — must justify why this scope and not narrower), `confidence`, and
  `provenance` (the `hitl_audit` record id(s) it was extracted from — **mandatory**, not optional;
  a fact with no provenance is not distinguishable from a hallucination later).
- Never writes to the memory store directly. It proposes; a separate step decides.

### 4.3 Dedup / contradiction check

Before anything reaches a human, a cheap deterministic pass (embedding similarity or a second
LLM call scoped only to "does candidate X already exist / contradict Y") collapses near-duplicates
and flags direct contradictions (a new candidate that conflicts with an already-promoted fact must
surface the conflict, not silently overwrite — memory that flips silently is worse than no memory).

### 4.4 Human-confirm queue — reuse the HITL Inbox, don't build a second one

Candidates land as a new `HitlItem.kind` ("memory-promotion") in the **existing** Inbox — same
approve/reject/modify shape already built, same audit trail, same "nothing runs invisibly"
guarantee the rest of the product holds to. `modify` lets an operator narrow an over-eager scope
(e.g. LLM proposed "workspace", operator narrows to "project") instead of a binary accept/reject.
This is deliberately the *only* new UI surface this whole pipeline needs — no new panel, no new
review model.

### 4.5 Auto-promotion — explicitly deferred, not this phase

Promoting a candidate straight into memory without a human ever seeing it is a **later** phase,
and only once there's a track record: this is where it ties into v5's "provably-improving fleet" —
measure which promoted facts actually reduced churn/HITL volume for tasks that used them, and only
consider auto-promoting the pattern of extraction that has a proven precision rate. Shipping
auto-promotion before that measurement exists is the single highest-risk way to poison the corpus,
because a bad fact doesn't just fail once — it gets re-injected into every future task in scope
until someone notices and deletes it.

---

## 5. Guardrails against a corpus that lies

Memory is a moat only if it's trustworthy; a corpus full of confidently-wrong facts is worse than
no corpus, because it gets **injected into every future run silently**. Concretely:

- **Provenance is mandatory, not metadata.** Every promoted fact links back to the `hitl_audit`
  record(s) it came from. The Audit/memory view renders "why do I believe this" on click — same
  transparency bar as the rest of the product's decision trail.
- **No promotion without a human confirm**, at least through the phase where precision is unproven
  (§4.5).
- **Scope defaults narrow.** An LLM proposing "workspace" scope from one project's one decision is
  the failure mode to design against — the extraction prompt should have to justify broader scope
  with *multiple* corroborating records, and the human-confirm step is the backstop either way.
- **Staleness/decay.** A fact tied to a file path, API, or dependency that no longer exists in the
  repo should be flagged (not silently kept) the next time distillation runs over that scope —
  otherwise the corpus only grows and never self-corrects as the codebase moves.
- **Contradiction surfaces, never silently resolves.** See §4.3.
- **Never fabricate absence of a fact either** — if a batch has no extractable signal, the
  pipeline should return an empty candidate list, not manufacture one to look useful. (Same
  discipline the eval suite already enforces on agents themselves — see
  [docs/llm-acceptance.md](docs/llm-acceptance.md) item 4, "no-op recognition.")

---

## 6. Evaluating distillation quality

This is exactly the kind of behavior the existing LLM-judged acceptance suite
([docs/llm-acceptance.md](docs/llm-acceptance.md)) is built for, not the deterministic `tests/`
suite — distillation quality is a rubric-scored judgment call, not a mechanical assertion. A
`memory-distillation` eval track would need scenarios shaped as:

- A batch of synthetic `hitl_audit` records with a **known** intended fact (e.g. three rejects
  all about the same lint rule) → judge scores whether the candidate matches, at the right scope,
  with correct provenance.
- A batch with **no** generalizable signal (one-off approvals, unrelated rejects) → judge checks
  the pipeline proposed nothing (the no-op-recognition analog for distillation).
- A batch with a **contradiction** against an existing fact → judge checks it surfaced as a
  conflict rather than silently overwriting.
- Precision over recall as the primary metric: a missed fact costs an operator one more manual
  note; a fabricated or over-scoped fact costs every future run in that scope until caught.

---

## 7. Recommended phasing

| Phase | What ships | Depends on |
|---|---|---|
| **0 — Memory v0 (non-LLM, v1.5)** | `MemoryFact` store + scoping; operator-authored facts; mechanical decision-derived capture (already-typed `memoryNote` promoted verbatim, no extraction); injection via the existing `project.instructions`-style seam. | — |
| **1 — Batched LLM candidate extraction** | Nightly/on-demand job over `hitl_audit` deltas → curating LLM (stateless consult) → dedup/contradiction pass → candidates land in the Inbox as `memory-promotion` HITL items. | Phase 0 |
| **2 — Cross-vendor + repo-native sync** | Promoted facts render into each vendor's native format (`CLAUDE.md`, `.cursor/rules`, Copilot instructions) via the runner-sdk seam. | Phase 1, runner-sdk multi-vendor breadth (v1) |
| **3 — Outcome-measured auto-promotion** | Track which promoted facts correlate with lower churn/HITL volume for tasks that used them; only then consider skipping the human-confirm step for extraction patterns with a proven precision rate. | Phase 1 + v5's outcome feedback loop |

Phase 1 is the concrete scope of this ROADMAP item ("start with operator-authored + decision-derived
facts, add a Skynet-side curating LLM later") — Phase 0 is the non-LLM prerequisite already scoped
separately, Phase 2/3 are the natural follow-ons this design doesn't want to foreclose.

---

## 8. Open questions (genuinely unresolved — flag before building)

1. **Batch cadence vs. freshness.** Nightly is cheap but means a fact learned Monday doesn't help
   a task run Tuesday morning. An on-demand "distill now" project action is probably needed
   alongside the scheduled batch, at least for v1.
2. **Cost model.** Batched + stateless keeps this cheap relative to per-event, but a
   multi-workspace hosted deployment (out of scope today, but v4 is explicitly open-core with a
   paid distillation layer) will need a real cost estimate before this scales past one operator.
3. **Cross-project generalization.** A fact learned in Project A that's actually a workspace-wide
   preference (e.g. "this operator always wants tests before merge") is the highest-value case and
   the easiest to over-generalize from a single project's history. Needs more than one project's
   worth of corroborating evidence before the curator should even propose workspace scope — exact
   threshold TBD, likely tunable per workspace rather than a hardcoded constant.
4. **Who curates the curator.** The dedup/contradiction pass in §4.3 is itself a judgment call
   that can be wrong (two facts that look similar but aren't, or vice versa). Worth deciding
   whether that pass ever needs its own confidence threshold that also routes to human-confirm
   rather than auto-collapsing.
5. **Export/open-format implications.** Once facts are LLM-distilled rather than purely
   operator-authored, the open memory spec (positioning.md's "openness is the second moat") needs a
   `provenance`/`source: "llm-distilled" | "operator" | "decision-derived"` field from day one, so
   an exported memory file is honest about what a human wrote vs. what an LLM inferred — otherwise
   the open format itself becomes a place fabricated-looking facts hide with no way to tell.

---

## 9. Summary recommendation

Don't build a curating LLM before Memory v0's non-LLM store exists — there's nothing to curate
into yet. When it's time for Phase 1, keep the curator a **stateless, batched, structured-JSON
consult** (same shape as the existing auto-review verdict), require **mandatory provenance** on
every candidate, and route every candidate through the **existing HITL Inbox** as a new
`memory-promotion` gate rather than building a second review surface. Auto-promotion is a
deliberately later phase, gated on an outcome-measurement track record (ties to v5), not a v4
deliverable — the risk of a silently-poisoned corpus outweighs the friction saved by skipping the
human-confirm step this early.
