# Skynet — GTM Brief v0.1

> First GTM base: positioning, offer, packaging, and first channel tests.
> Every section ends with **testable assumptions** — explicit bets to validate before scaling spend.

---

## 1. Target Audience — Ideal Customer Profile

### Primary ICP: The Power Developer (launch wedge)

**Who:** Solo developer or small team (1–3 engineers) who already uses Claude Code, Codex, or
Cursor in their daily workflow and has hit the ceiling of "one agent at a time."

**Profile:**
- Ships production code; likely founder, lead, or staff-level IC
- Pays their own Anthropic/OpenAI API bills — cost-aware, not cost-blocked
- Has tried running two agents manually and felt the coordination pain (conflicting branches,
  losing context, no audit of what the agent actually did)
- Values control: they want agents to accelerate work, not replace their judgment

**Pain they feel:**
- "I can only watch one agent at a time — the others sit idle"
- "I don't know what it changed until after the fact"
- "Every editor/agent has its own memory — nothing carries over"
- "I can't show my team (or my auditor) what the AI actually did"

**Job to be done:** Ship more, without losing ownership of what ships.

**Why Skynet wins here:** v0 is already this — local desktop app, BYO key, full HITL Inbox,
multi-provider fleet, isolated worktrees. Zero onboarding friction on the governance side.

---

### Secondary ICP: The Compliance-Aware Engineering Lead (near-term upsell)

**Who:** Engineering lead at a 10–50 person company in a regulated or risk-conscious industry
(fintech, health tech, SaaS with enterprise contracts, EU-based companies).

**Pain:** Using AI agents on production code without audit trails is a liability. Either they've
banned agents entirely, or they're holding their breath every time one touches a sensitive file.

**Job to be done:** Let AI agents accelerate the team, with a paper trail good enough for a
customer audit or EU AI Act inquiry.

**Why Skynet wins here:** Tamper-evident audit trail, signed "AI change report," policy-as-code,
prompt-injection firewall — this cohort buys governance first, speed second.

---

### Tertiary ICP (deferred — post-v1): Enterprise / Multi-Team

Multi-team orgs running dozens of agents across projects. Needs hosted, SSO, SIEM export, role-
based approval. Explicitly out of scope until the hosted release (🏢 deferred in the roadmap).

---

**Testable assumptions — ICP:**
- [ ] **A1:** Power developers who already pay $50+/month in API costs convert to active Skynet
      users at a higher rate than developers who haven't tried an AI agent yet.
- [ ] **A2:** "Parallel fleet" is the hook for Power Developers; "audit trail" is the hook for
      Compliance Leads — these cohorts need different landing-page messaging.
- [ ] **A3:** The primary ICP self-identifies through which agent they use first (Claude → Skynet
      via the Anthropic ecosystem; Codex/Cursor → via the "works with your existing agent" angle).

---

## 2. Core Messaging

### Headline (primary)
> **Run a fleet of AI coding agents. Stay in control.**

### Subheadline
> Skynet is the mission-control layer for your AI agents — parallel worktrees, a unified inbox for
> every decision, cross-vendor support, and a tamper-evident audit trail. Not another agent. The
> operating layer over all of them.

### Elevator pitch (one sentence)
> Skynet lets you run Claude, Codex, Gemini, Cursor, and Copilot as a supervised fleet — each
> agent in its own isolated branch, every tool call and merge gated through a single human inbox.

### The three value messages (in priority order)

**1. Control at scale**
You stay the decision-maker. Every tool call, diff, and merge goes through your inbox — or gets
auto-approved by rules you wrote. Autonomy is a dial, not a binary.

**2. Works with what you already use**
No new agent to learn. Skynet drives Claude Code, Codex, Gemini, Cursor, Copilot, and OpenCode as
runners. Switch vendors anytime; your workflow stays the same.

**3. Audit trail from day one**
Every AI-authored change is logged, hash-chained, and exportable as a signed "AI change report."
Know what the agent did, who approved it, and why — before a customer or auditor asks.

---

**Testable assumptions — messaging:**
- [ ] **A4:** "Stay in control" out-converts "ship faster" as the primary hook in cold outreach and
      ads (hypothesis: the developer persona fears losing ownership more than they fear slow shipping).
- [ ] **A5:** "Works with what you already use" dramatically reduces objection to trying Skynet vs.
      messaging that asks users to switch agents.
- [ ] **A6:** Compliance/audit messaging resonates on LinkedIn/enterprise channels but not on Hacker
      News or X — segment messaging by channel.

---

## 3. Differentiation

### Competitive landscape (brief)

| Competitor category | How they position | Skynet's edge |
|---|---|---|
| **Fully autonomous agents** (Devin, SWE-agent) | "Let the agent do everything" | Human stays in the loop; runs locally; no black box |
| **Single-vendor copilots** (Copilot Workspace, Cursor) | Deep IDE integration for one vendor | Provider-agnostic; fleet not single-agent; governance layer missing from all copilots |
| **DIY orchestration** (LangGraph, custom scripts) | Build your own | Purpose-built for coding agents; HITL, audit, VCS all built in; maintained |
| **CI-based agents** (Sweep, Mentat) | Triggered by issues/PRs | Richer HITL; parallel fleet; local-first privacy; cross-vendor |

### Unique differentiators (competitor sweep found these rare or absent)

1. **Prompt-injection firewall** — detects when content the agent read (an issue body, a web page,
   a vendored README) is steering its tool calls, and forces a human gate. No competitor has this.

2. **Cross-vendor HITL Inbox** — one inbox for Claude + Codex + Gemini + Cursor + Copilot. A
   single-vendor tool can't offer this by construction.

3. **Portable, open memory** (v1.5+) — user-owned, cross-vendor, git-committable, MCP-exposed.
   Your accumulated context follows you across agents and vendors. A switching cost you control.

4. **Signed AI change report** — one-click compliance evidence (Ed25519-signed, built from the
   tamper-evident audit trail). Directly addresses EU AI Act and enterprise audit requirements.

5. **Local-first, BYO key** — keys never leave your machine. No API proxy. No vendor lock-in.
   Privacy as a first-class property, not a setting.

### The positioning sentence (internal compass)
> Vendors own the agent. Skynet owns the operator's accumulated context and governance leverage
> across all agents. The agent improves for free; the moat is everything vendor-independent that
> compounds with use.

---

**Testable assumptions — differentiation:**
- [ ] **A7:** The prompt-injection firewall is the most surprising differentiator in demos — leads
      to the most "I didn't know I needed this" reactions. Test: track which feature drives the
      most follow-up questions in user interviews.
- [ ] **A8:** "Local-first, BYO key" is a hard requirement for at least 30% of the primary ICP
      (privacy/security-conscious developers). Test: ask directly in onboarding survey.
- [ ] **A9:** Cross-vendor support is more compelling as a risk hedge ("don't bet on one vendor")
      than as a current multi-tool workflow. Most users start with one provider and value breadth
      as insurance.

---

## 4. Packaging

### Philosophy: give away the floor, sell the ceiling

The orchestration layer (running agents, HITL Inbox, worktrees, audit log) is the user-acquisition
funnel. It is free. The moat — portable memory, team knowledge sync, compliance exports — is the
paid layer. This matches the open-core playbook and the positioning (orchestration = table stakes;
memory + governance = the compounding moat).

### Tiers (hypotheses — not final)

**Tier 0 — Free (local desktop, open-source)**
- Full fleet orchestration: unlimited agents, all providers
- HITL Inbox, command safety, worktrees, merge queue
- Audit log (local, exportable as NDJSON)
- Basic compliance report (unsigned, single-run)
- BYO key — operator pays their own API bills
- **Goal:** maximise installs and "first fleet run" activations

**Tier 1 — Solo Pro (hypothesised: $15–25/month)**
- Everything in Free
- Deep review + breaker review (adversarial second-pass agent)
- Signed compliance evidence pack (Ed25519, full date-range export)
- Browser tools for agents (Playwright MCP, verified UI testing)
- Priority support
- **Goal:** capture power users who want production-grade safety and CI-quality review

**Tier 2 — Team (hypothesised: $30–60/seat/month, min 3 seats)**
- Everything in Solo Pro
- Shared portable memory across team members (cross-vendor, git-committable)
- Org-wide knowledge diffusion (one decision informs all agents)
- Team inbox (delegated approvals, 2-person rule for high-risk gates)
- Shared policy library (version-controlled command policies)
- **Goal:** land teams, grow seat count; unlock the memory moat's social flywheel

**Tier 3 — Enterprise (custom pricing)**
- Everything in Team
- Hosted deployment (multi-tenant, SSO/OIDC, CORS hardening) — requires the 🏢 hosted release
- SIEM export of tamper-evident audit trail
- EU AI Act compliance package (certified reports, policy archiving)
- SLA, dedicated onboarding, custom integrations
- **Goal:** close regulated-industry deals; starts as a relationship play, not self-serve

---

**Testable assumptions — packaging:**
- [ ] **A10:** Free tier creates enough "wow" that at least 20% of active users hit a feature gate
      within 30 days and see a reason to upgrade (if not, the free tier is too generous or the paid
      features are wrong).
- [ ] **A11:** Solo Pro's signed compliance report is the #1 solo-upgrade driver (ahead of deep
      review and browser tools). Test: show each feature as the upgrade gate in A/B.
- [ ] **A12:** Team tier pricing based on seats (not usage) is preferred by the secondary ICP —
      predictable cost matters more than usage-efficient billing for compliance buyers.

---

## 5. Pricing Hypotheses

Four mutually exclusive pricing models — to be validated with user interviews and early revenue
data before committing.

### H1 — API key as natural paywall (current state)
Free forever. No Skynet subscription. Revenue = none (users pay API vendors directly).
- **Logic:** build the network, monetise the moat (memory, compliance) later as open-core.
- **Risk:** long time to revenue; memory moat takes 12+ months to reach density.
- **Test signal:** do free users stick around long enough to hit the memory moat naturally?

### H2 — Freemium with agent-count gate
Free: 1 concurrent agent. Paid: fleet (3+ agents).
- **Logic:** the fleet is the core value — gate it naturally.
- **Risk:** the primary ICP (solo dev) may only ever need 2 agents; gate too low = churn.
  Gate too high = no upgrade. Needs calibration from actual usage data.
- **Test signal:** what % of free users consistently run 2+ agents simultaneously?

### H3 — Feature gate (current hypothesis — Solo Pro)
Free: orchestration. Paid: advanced review + compliance + team memory.
- **Logic:** separates "use the product" from "trust the product for production." Matches
  the ICP segmentation (Power Developer = free enough; Compliance Lead = clear paid reason).
- **Risk:** the free tier must be genuinely useful or users won't stick around to hit the gate.
- **Test signal:** track upgrade events by feature gate. If nobody hits a gate, reprice/repackage.

### H4 — Usage-based (per agent-run or per merge approved)
Free: 50 agent-runs/month. Paid: metered above.
- **Logic:** aligns cost with value delivered. Natural for BYOK model.
- **Risk:** adds billing anxiety; AI usage is bursty and unpredictable. Devs hate surprise bills.
- **Test signal:** survey: "would you rather pay $20/month flat or $0.50 per agent-run?"
  Expectation: flat pricing wins 3:1.

**Recommended starting hypothesis:** H3 (feature gate), with H2 (agent count) as a secondary
signal to collect. Revisit at 100 active users with real usage telemetry.

---

**Testable assumptions — pricing:**
- [ ] **A13:** Developers self-reporting as "paying $50+/month for AI APIs" show willingness to pay
      $15–25/month for Skynet Pro at a rate of ≥25% (test via pricing page intent survey).
- [ ] **A14:** Flat monthly pricing (H3) has ≥3× higher conversion intent than metered (H4) in the
      primary ICP — developers are risk-averse about usage bills on top of API bills.
- [ ] **A15:** The Solo Pro price point sweet spot is $19/month: below the "is this worth it?"
      mental hurdle for solo devs, above the "this must be toy software" floor. Test via pricing
      page variant ($9 / $19 / $29).

---

## 6. First Testable Distribution Channels

### Channel 1 — Hacker News (Show HN)

**Why first:** HN is the primary discovery surface for developer tools. The Skynet story is HN-
native: local-first, BYO key, anti-black-box, open architecture, prompt-injection firewall as a
genuine technical novelty. "Show HN: I built mission control for running coding agents in parallel"
is a natural headline.

**Format:** Show HN post with a 2–3 minute demo video. Lead with the prompt-injection firewall
finding ("no competitor has this") — technical novelty is what earns HN upvotes.

**What to measure:** upvotes, comments, installs on launch day, GitHub stars, sign-ups to an early
access list.

**Hypothesis:** A Show HN post lands ≥100 upvotes and drives ≥200 GitHub stars within 48 hours.

---

### Channel 2 — X (Twitter) developer community

**Why:** The AI developer Twitter community is active, early-adopter, and highly shareable. Demo
videos of unexpected AI agent behavior get organic reach.

**Format:** Demo thread showing the fleet running, the HITL Inbox catching something surprising
(a prompt injection attempt, an outside-worktree write) with a short screen recording. Lean into
the "what the agent tried to do vs. what got approved" contrast — it's both compelling and
differentiating.

**Target accounts for seeding:** AI-adjacent developers with 5k–50k followers who build in public.

**What to measure:** impressions, link clicks to the GitHub/download page, direct DM conversion to
installs.

**Hypothesis:** A 60-second screen-recording thread of "the HITL Inbox catching a prompt injection"
reaches ≥10k impressions organically without paid amplification.

---

### Channel 3 — GitHub (open-source repo as the product page)

**Why:** The primary ICP discovers developer tools through GitHub. Stars, README quality, and
a live demo GIF are the conversion funnel. Open-sourcing the orchestration layer (the free tier) is
also consistent with the "open-core: give away the floor" strategy.

**Format:** A production-quality README with a 30-second GIF of the fleet running, clear
"one-command install" onboarding, and the five signature bets called out prominently.

**What to measure:** Stars/week, forks, issues opened (a proxy for engaged users), conversion from
star → desktop app download.

**Hypothesis:** A well-crafted README + GIF drives ≥50% of stars to click through to the download
page within the first month.

---

### Channel 4 — AI developer communities (Reddit, Discord)

**Subreddits:** r/ClaudeAI, r/LocalLLaMA, r/ChatGPTCoding, r/SideProject
**Discords:** Anthropic developer community, OpenAI developer forums, indie hacker communities

**Format:** Authentic participation — answer questions about running multiple Claude Code agents,
then share Skynet as the solution. Not spam: engage first, share when genuinely relevant.

**What to measure:** upvotes on posts, DM conversations, installs from referral links.

**Hypothesis:** Organic community posts in r/ClaudeAI (specifically: "how do I run multiple Claude
Code agents?") will be the highest conversion-rate channel because users already have the pain.

---

### Channel 5 — Product Hunt (launch campaign)

**Why:** Product Hunt drives a concentrated spike of early adopter installs, press attention, and
"social proof" (upvote count) that can anchor credibility for outbound and LinkedIn.

**Format:** Full PH launch with a 2-minute demo video, a clear "what's different" list, and a
"coming soon" pre-launch to build a notify list before launch day.

**Timing:** After HN launch (use the HN traction as social proof in the PH listing).

**What to measure:** #1 product of the day, total upvotes, install conversions on launch day.

**Hypothesis:** A strong PH launch (#1 or Top 3 of the Day) converts at ≥5% of unique visitors to
a download, higher than any other channel in the first week.

---

### Channel priority ranking (recommended order)

1. **GitHub** — always-on, permanent SEO and discovery surface. Set up first.
2. **Show HN** — highest-quality developer traffic, best for initial signal. Do at v0 beta quality.
3. **X demo thread** — amplify the HN story; low cost, viral potential.
4. **Community posts** — organic, high-intent, good for learning pain language.
5. **Product Hunt** — one-shot launch spike; save for a polished v1 or major milestone.

---

**Testable assumptions — channels:**
- [ ] **A16:** Show HN is the single highest-volume install day (test: compare day-1 installs from
      HN vs. all other channels combined in the first 30 days).
- [ ] **A17:** Community posts in r/ClaudeAI have higher conversion (visitor → install) than Show
      HN traffic, because visitors already feel the pain.
- [ ] **A18:** A 60-second screen recording out-converts a written description in every channel
      (test: two versions of the X thread — video vs. text + screenshots).
- [ ] **A19:** GitHub stars convert to desktop-app downloads at ≥15% (meaning the README + GIF is
      a meaningful part of the conversion funnel, not just vanity).

---

## 7. Assumptions Summary and Testing Sequence

Priority order for the first 60 days:

| # | Assumption | How to test | Signal |
|---|---|---|---|
| A1 | Power devs paying $50+/mo in API costs are the highest-converting ICP | Onboarding survey Q1 | ≥40% of active users confirm |
| A4 | "Stay in control" > "ship faster" as hook | Landing page A/B or ad copy split | CTR / conversion |
| A16 | Show HN = #1 install day | Attribution tracking (UTM) on all channels | Day-1 installs by source |
| A8 | "Local-first, BYO key" is a hard requirement for ≥30% of ICP | Onboarding survey Q2 | Direct response |
| A13 | $50+/mo API spenders show ≥25% willingness to pay $15–25/mo | Pricing intent survey on the landing page | Click rate on "notify me" at each price |
| A10 | ≥20% of free users hit a paid feature gate within 30 days | In-app event tracking (feature gate impressions) | Rate over first 30 days |
| A7 | Prompt-injection firewall = most surprising differentiator | Demo reaction / follow-up questions in user interviews | Qualitative signal from first 10 interviews |

---

## 8. What This Brief Does NOT Decide

These are adjacent questions that need separate briefs or more data before deciding:

- **Open-source vs. source-available:** The orchestration layer is described as "free" but the
  license model is not decided here. This matters for GitHub discovery and community trust.
- **Hosted release timing:** The 🏢 deferred hosted deployment is a separate GTM event with
  its own ICP (teams, not solo devs) and pricing. Not this brief's scope.
- **Memory monetisation model:** How to price the open-core paid memory tier (distillation, team
  sync, hosted sync) requires the feature to land first. Deferred to a v1.5 GTM brief.
- **Influencer / paid amplification:** Not addressed here. Validate organic channels first;
  only add paid once you have a channel that converts at a known rate to optimise against.
