# Skynet — Positioning & Moat

> The principle that should guide every build decision: **wrap, don't rebuild.**
> Skynet is not a coding agent. It is the management, memory, and leverage layer over a
> fleet of best-in-class *third-party* coding agents (Claude Code, Codex, Gemini, Cursor,
> Copilot). The agents are a fast-improving commodity; our value is everything around them
> that is vendor-independent and compounds with use.

## 1. Wrap, don't rebuild

Anthropic/OpenAI/Cursor win the "make a great coding agent" race, and they'll keep getting
better for free. We do not compete there. The `runner-sdk` is a **thin adapter** that delegates
to the vendor's own agent:

- The Claude runner drives the **Claude Agent SDK** (headless Claude Code) — same engine as the
  CLI. "Assign work to a Claude Code agent" *is* what it does; we can also shell out to the real
  `claude` CLI for maximum fidelity.
- We surface the agent's **own** permission/HITL prompts (Claude Code's `canUseTool`), capture its
  diffs/output, and get out of the way. No planning, coding loop, or tool logic of our own.

**Lines not to cross:** don't build the agent's planning, code-editing, or tool use. Keep runners
maximally thin (robust to vendor updates, less to maintain). LLM-powered *helpers we add*
(memory distillation, task critique, a manager's decomposition) are fine — they're Skynet-side
orchestration that leans on the model's thinking; they are not us re-implementing an agent.

## 2. What Skynet is

The **operating layer for a fleet of off-the-shelf coding agents** — the part that is
"not managed correctly yet." Provider-agnostic is a feature, not a hedge: don't bet the company on
which agent wins, and let a team use Claude for one area and Codex for another.

## 3. The moat — three compounding layers

### Layer 1 — Orchestration (table stakes, mostly built)
Run, supervise, and coordinate many agents at once: assignment + isolated runners, the HITL Inbox,
**no double work** (conflict families + module ownership), **merge orchestration** (the queue),
audit, the fleet view, and the **area-manager hierarchy**. This is the management plane.

### Layer 2 — Portable cross-vendor memory (the strongest moat)
Because **every agent's work streams through Skynet** (logs, plans, diffs, chat, and especially
HITL decisions), Skynet is the only layer positioned to own a memory no single vendor can:

- **Cross-vendor** — the same accumulated context injected into Claude *or* Codex *or* Gemini,
  translated into each one's native mechanism. The `runner-sdk` is the single, vendor-agnostic
  **injection point**, so the memory is portable across vendors by construction.
- **Long-lived & compounding** — persists across runs, projects, and vendor churn; grows more
  valuable the more Skynet is used.
- **Portable & owned** — the user can read/edit/export/move it. Their asset, not vendor lock-in.
- **Scoped** — workspace / project / **area** / agent-family. Ties to the hierarchy: an area
  manager accumulates area memory its workers inherit.

We already persist the raw material — the `hub` sees every event and **`hitl_audit` captures every
human judgment** ("decided X because Y"). Memory is the curated/distilled layer on top.
*Why defensible:* a switching cost **and** a compounding data asset **and** vendor-independent — it
strengthens precisely as the agent market churns.
*Honest caveat:* auto-distilling good memory is hard. Start with operator-authored + decision-derived
facts; LLM-assisted distillation later (a Skynet-side helper, not an agent).

*Openness as a second moat (decided):* don't lock the memory in — **publish an open, git-committable
memory format and expose the brain as an MCP server any tool can read/write, even outside Skynet.**
Counter-intuitively, openness *strengthens* the moat: users only entrust their accumulated knowledge to
something they can't be locked out of, so open = trust = adoption = Skynet becomes the default hub. The
durable moat then shifts from *owning the format* to **curation quality + the accumulated personal corpus +
being the hub** (the git → GitHub play). Open-core: the format + read/write MCP are free (drive ubiquity);
distillation quality, cross-vendor translation, hosted sync, team sharing, and governance are the paid layer.
This also reframes the market — the orchestration tier is overwhelmingly free/OSS, so we do **not** monetize
orchestration; we give it away to acquire users and monetize the moat.

### Layer 3 — Agent fluency (the flywheel)
**More agents + clearer tasks → better results *and* more usage.** Skynet should make users better
fleet operators across a spectrum:
- **Automated:** the area-manager decomposes work for you.
- **Assistive:** a **task linter** (vague task → "touches 3 modules, split into 3?"; "no 'done'
  definition?"), **parallelism nudges** ("idle runners + deep backlog → spin up more?"), and a
  **feedback loop** showing which task phrasings one-shot cleanly vs. churn through HITL — so users
  *learn what good looks like*. Compounds with Layer 2 (the coach learns from workspace history).

## 4. The thesis

**Vendors own the agent. Skynet owns the user's accumulated context and operating leverage across
all agents.** The agent improves for free; the moat is everything vendor-independent that compounds
with use.

## 5. Build implications — preserve the hooks, don't build it yet

Layers 2 & 3 are **post-MVP**. MVP stays: orchestration + drive one real agent (Claude). But don't
architect them out — the cheap hooks already exist:
- The **`hub`** is the single chokepoint for all streams → memory's raw material flows through it.
- The **`hitl_audit`** trail is the decision corpus memory distills from.
- The **`runner-sdk`** is the one place context is injected into an agent → keep it the vendor-agnostic
  seam so memory injection is provider-neutral later.
- Keep runners **thin** so vendor upgrades flow through, and so the value stays in our layers.

Future workstreams (not MVP): **M1 Memory layer** (store + scoping + injection via runner-sdk +
distillation from audit), **M2 Agent-fluency** (task linter, parallelism nudges, outcome feedback).
