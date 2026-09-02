# Skynet — Roadmap

**How to read this:** Skynet ships in versions. **v0 (MVP) is the only committed scope**; later
versions are directional and will be reordered as we learn. Deep detail for big features lives in
`docs/` briefs. The principle behind every entry: **wrap, don't rebuild** — Skynet is the
management/memory/leverage layer over off-the-shelf coding agents, not an agent itself
(see [docs/positioning.md](docs/positioning.md)).

**Committed target = the local desktop app.** The only in-scope release right now is the
**local-first Electron app** (BYO key, runs on the operator's own machine, keys never leave the host).
A **hosted / multi-tenant** deployment is **explicitly out of scope** — everything that exists only to
serve one (GCP infra, multi-replica scale, SSO, CORS/rate-limit hardening, team roles, SIEM export) is
deferred and tagged 🏢. See **[Deferred — hosted release](#deferred--hosted--multi-tenant-release-not-in-scope-)**.

**Sequencing — ship staggered, not "orchestration then moat."** The memory moat *compounds with
usage*: it distills from the streams (`hub`) and decisions (`hitl_audit`) that only exist once people
run agents through Skynet, so waiting for the moat means launching with an empty second brain. We do
**not** wait. We **launch on governance** (the safety layer + decision audit + HITL Inbox — already
built, and genuine white space vs. every competitor surveyed), capture memory raw material from the
first run, and pull a **thin Memory v0 forward** (v1.5) so we're never "just another orchestrator."
The area-manager hierarchy (v2) deliberately waits *behind* the moat's start. **Orchestration is the
funnel; governance is the launch wedge; portable, open memory is the moat.**

**⭐ Signature bets** — the "nobody-else-has-this" differentiators (a competitor sweep of 60+ tools
found these rare-to-absent), and where they live:
1. **Open portable memory — one second brain across every agent** (v4; thin v0 in v1.5): user-owned,
   cross-vendor, exposed as an **MCP memory server any tool can read/write, even outside Skynet**.
2. **Cross-vendor consensus runs** (v1.5): same task on Claude + Codex + Gemini, auto-diff, keep/merge
   the winner — or have them peer-review each other.
3. **Prompt-injection / tool-poisoning firewall** (v1, landed): gate tool calls steered by untrusted content the
   agent read (issue / web page / dependency). The category's first agent-security layer.
4. **Provably-improving fleet** (v5): measure which memory + task phrasings one-shot vs. churn, promote
   the winners, and show the user the curve.
5. **Compliance evidence pack** (v1): one-click signed "AI change report" — every AI-authored change +
   who approved + why + the policy at the time (EU AI Act tailwind).
6. **Org-wide knowledge diffusion** (v1 mass-inform + v4): one teammate's decision instantly informs
   every teammate's agents.

**Recommended near-term order (re-prioritized on the findings)** — ship in this order:
**(1) Provider breadth** (Codex/Gemini/Cursor/Copilot + **OpenCode**) — the *only* place we trail the field,
and it's table stakes (also unlocks consensus runs); **(2) Governance-to-SOTA quick wins** (the launch wedge,
mostly already built) + **guided provider connect**; **(3) v1.5** ease-of-use + **Memory v0** (the wedge that
makes us not-just-another-orchestrator); **(4) Cross-vendor consensus runs** (needs the v1 providers).
Everything below stays directional.

**Current batch priority order** — see [docs/operating-memo.md](docs/operating-memo.md) §8 for full rationale.
Items are ranked PMF > Platform > Product within each batch:

| Batch | # | Item | Track |
|-------|---|------|-------|
| **N (now)** | 1 | 🔒 Security hardening — Aug 2026 audit remediation (7 findings, see v1 section) | Security |
| | 2 | deep-review / breaker-review settings UI toggle | PMF |
| | 3 | Memory v0 — operator-authored facts, injected per project | Platform |
| | 4 | Reactive runner breadth (Kimi Code landed) | Product |
| | 5 | First-run onboarding telemetry (anonymous install events) | PMF |
| | 6 | Mass inform — Fleet/Project UI (multi-select + whole-project) | Product |
| **N+1** | 1 | Memory v0 — decision-derived fact capture from `hitl_audit` | Platform |
| | 2 | Desktop code-signing (macOS + Windows) | GTM |
| | 3 | Cross-vendor consensus runs (same task, two agents, auto-diff) | Platform |
| | 4 | Preview Phase 2 — service-container runtime + auto-rebuild on merge | Product |
| **N+2** | 1 | Memory v0 — workspace-scoped MCP read/write server | Platform |
| | 2 | Autonomy telemetry dashboard (ZTMR, HITL volume, resolution time) | PMF |
| | 3 | Approve-with-rule batch mode (similar gates, one decision) | PMF |
| | 4 | Plan entity + project view panel (Product Steward foundation) | Platform |

Legend: 🔬 = needs an LLM / open research · 🔗 = has a design brief · ⛓ = depends on earlier version ·
🏢 = hosted-only (deferred; **not** needed for the local desktop release).

---

