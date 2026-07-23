# UX / UI Review — pre-release audit (July 2026)

**Method:** walked the real app end-to-end against a live keyed server — first-run
onboarding (all 4 steps), project creation, every nav view (Home ×4 lenses, Inbox,
Audit, Projects, project kanban, Fleet incl. add-flow, Integrations, Settings,
Acceptance, Simulation), the task composer, plus prior live captures of the gate /
diff-review / subway-with-runs flows. ~25 screenshots, console monitored (zero
errors across the entire tour — notable). Viewports 1440×900 and 1024×800.

**Verdict:** the foundation is genuinely strong — a coherent, confident
mission-control identity (dark, Space Grotesk + IBM Plex Mono, amber brand), an
onboarding wizard better than most dev tools ship, and gate cards that already
lead the category in decision context. What separates it from SOTA is **routing/
state integrity, guidance between steps of the core loop, disabled-state and
small-type legibility, and micro-interaction polish.** Nothing structural.

Grades: Identity **A−** · Onboarding **B+** · Core loop guidance **B−** ·
Information design **B+** · Interaction states **C+** · Accessibility **C** ·
Perceived quality (motion/detail) **B−**.

---

## P0 — fix before release (integrity + first impressions)

### 1. Router & navigation-state integrity
- **Settings, Acceptance, Simulation are not deep-linkable** — `parseHash()` only
  knows home/queue/audit/projects/fleet/integrations. A refresh on Settings dumps
  the user to Home; these views can't be shared or restored.
- **Stale nav highlight:** navigating by hash (back/forward, deep link) updates
  content but the sidebar highlight lags; after a few navigations **three items
  rendered as "active" simultaneously** (Home + Inbox + Audit).
- Root cause is twofold: incomplete route table, and **`:focus` styling identical
  to the `.on` active style** — a previously-clicked nav button keeps its lit look.
- **Fix:** complete the route table (every view addressable); derive `.on` purely
  from router state; give focus a distinct `:focus-visible` ring (accent outline,
  not fill). *Small effort, large trust payoff — window title should also reflect
  the current view/project (it's a desktop app; the titlebar is permanently
  "Skynet — Agent Network").*

### 2. Onboarding: placeholder placement + blocked-CTA legibility
The wizard's craft is high (pips, step tags, honest copy). Two exceptions:
- **Step 2 of 4 is a `PLACEHOLDER`** (GitHub App install "isn't wired yet"). A
  first-run user meets an unfinished feature as the second thing in the product.
  → Move GitHub out of the wizard (Integrations already owns it) or collapse it
  to an optional "Connect later" card without the placeholder framing.
- **Step 4's disabled CTA reads as broken:** "Enter Skynet →" dims and the reason
  ("Select at least one provider.") sits in small faint mono far from the button.
  → Standardize a **blocked-CTA pattern**: keep the button visually solid but
  inert, with the reason directly beneath it at readable contrast.
- **Workspace name is client-side only** (localStorage). Open the app on another
  machine/profile and "Cyberdyne Systems" silently reverts to "Skynet". → Persist
  on the workspace record server-side.

### 3. Disabled-state system (global)
Dim-amber disabled buttons ("Create project", "Add to backlog", "Enter Skynet")
consistently read as *rendering glitch*, not *blocked with a reason*. One system:
distinct disabled treatment (desaturate + reduced opacity + `not-allowed` cursor)
**plus an inline reason line** when blocking is conditional. Applies to GetStarted,
task composer, wizard, fleet form.

### 4. Small-type legibility floor
Recurring 9.5–11px faint-mono hints (subway `start/ship` labels, backlog subtitle,
folder-picker hints, timeline legend) fall below comfortable contrast at desktop
distance and likely fail WCAG AA. → Establish a floor: **11px minimum, `--muted`
(not `--faint`) for any text carrying meaning**; reserve `--faint` for pure
decoration.

---

## P1 — the core loop should sell itself (guidance + affordances)

### 5. Continuation after "Create project"
Creating a project lands on the Projects overview with a card saying "No tasks
yet — open to add some". The user must rediscover the thread. → After create,
**open the project with the task composer focused**. Better: keep a **first-run
checklist** on Home (Create project ✓ → Add a task → Assign an agent → Approve
its work) until the first merge — the GetStarted copy already promises exactly
these steps; make them a live progress artifact.

### 6. Task composer
Name + description split is right (name 0/80 counter, description for the brief).
Polish: autofocus the name field; mark description "optional — the full brief the
agent receives"; ⌘↵ submits; blocked-CTA reason per #3 ("name required").

### 7. Assignment discoverability
"Assign task →" lives on Roster idle-runner rows, and the kanban path is
non-obvious (my scripted pass never found an assign affordance on the card).
→ Backlog/todo cards should carry a primary **Assign →** action (and later,
drag-to-ONGOING as an alias). The whole product hinges on this verb; it should
never require hunting.

### 8. The Autonomy toggle is a silent policy switch
A bare checked-by-default "Autonomy" checkbox in the project header changes
gating/triage behavior with zero explanation. → Subtitle it ("agents triage the
backlog and start auto-pick tasks; risky actions still gate"), and consider
default-off for a user's first project — autonomy is more impressive *after* the
user has seen the gates work.

### 9. Fleet copy & guardrails
- "**1 agents** configured" (pluralization).
- Verb mismatch: header button "+ Configure agent" opens a form ending in "Add to
  fleet" — pick one ("Add agent").
- **Retire** sits red and equally-weighted beside Configure on every card; move
  destructive actions behind the card's detail/overflow, or confirm inline.
- The provider strip in the subtitle ("Claude, Codex, Gemini, Cursor, Copilot")
  reads as *configured* — it's the *catalog*. Label it ("available providers").

### 10. Inbox empty state as a teaching moment
"Queue clear — no human override required" is good tone. Add one line of *what
arrives here* ("command approvals, plan sign-offs, diff reviews, merge conflicts")
with the four kind-chips rendered — first-run users learn the gate vocabulary
before the first gate fires. The dual readout (waiting/resolved) duplicates the
status bar — fold in a "delegated to policy" count later (blueprint G-gates).

---

## P2 — visual system & perceived quality

### 11. Layout breathing at width
Most views are a single left-hugging column with a vast empty right half at 1440
(Integrations is one row; Fleet cards ~360px). → Introduce a content container:
either center with `max-width` or commit to purposeful two-column layouts
(e.g. Fleet: cards left, aggregate utilization/cost right; Integrations: catalog
grid). Emptiness currently reads unfinished rather than calm.

### 12. Amber does three jobs
Amber = brand mark, primary action, *and* "waiting/blocked" status. When a
"waiting 7m" pill, a primary button, and the logo share a hue, status scanning
degrades. → Keep amber for brand + primary + needs-you; shift caution/blocked
status to a distinct hue (or differentiate by shape/weight only, never hue alone
— also the colorblind-safe rule).

### 13. Iconography
Nav glyphs are unicode characters (⌂ ⊙ ❑ ◇ ⑂ ⚙ ✓ ◐) with uneven optical weight.
Swap for a single 16px stroke set (Lucide fits the terminal-modern tone), same
metrics everywhere; keep ⑂ as the fork motif in *content*, where it's brand.

### 14. Motion & transition tokens
Almost no animation outside the gate card's `leaving` fade. Define two tokens
(fast 120ms / standard 200ms, ease-out) and apply: view/lens crossfade, card
enter (4px rise + fade), station-dot state changes, inbox card resolve collapse,
subway merge-line draw-in (the fold-back begs for a 300ms line animation).
Respect `prefers-reduced-motion`.

### 15. State-layer consistency
Hover exists on some cards (.proj, rows) and not others (kanban cards, fleet
cards). Define one interactive-surface rule: hover = raised bg + border-line
shift, active = 1px translate, focus = accent ring. Apply everywhere clickable —
and nothing non-clickable gets a hover.

---

## P3 — SOTA differentiators (post-release candidates)

16. **Command palette (⌘K)** — navigation + verbs ("assign…", "approve latest
    gate", "open billing service"). The operator persona lives on the keyboard.
17. **Keyboard-first Inbox** — `QueueView` already tracks `selectedIdx`; finish
    it: j/k navigate, a approve, r reject, m modify, enter opens the run. Show a
    shortcut bar. This turns gate triage into a flow.
18. **OS notifications + dock badge** for new gates (it's an Electron app;
    waiting-minutes are the product's core currency).
19. **Timeline lens depth** — zoom, brushing, click-through to runs; it's the
    natural "what happened while I was away" view.
20. **Cost/usage surfacing** — tokens/cost exist per run; roll up per project in
    the header and per runner in Fleet (pre-figures the blueprint's budgets).
21. **Accessibility pass** — aria-labels on icon-only buttons, focus-visible
    everywhere, contrast audit vs the #4 floor, reduced-motion.

---

## What's already excellent — protect these
- **Gate cards**: agent's reason, exact command, risk chips, classifier flags,
  real GitHub-style diff — best-in-class decision context; nothing in the
  competitive set (Conductor/Octomux/AO) shows this much before an approval.
- **Onboarding craft** (pips, step framing, honest placeholder copy) and the
  **Settings provider cards** (READY-TO-RUN chips, env-override semantics, docs
  links) — keep this pattern for every future provider.
- **Empty states with next actions** ("No tasks yet — add one in the project").
- **The status bar** (running / need-you / busy / idle / longest-wait) — a real
  cockpit strip; consider making each segment a click-filter.
- **Zero console errors** across the entire tour.

## Suggested sequencing
1. **Router + nav-state + focus ring** (P0.1) — small, restores trust.
2. **Disabled-state system + type floor** (P0.3/0.4) — one CSS pass.
3. **Onboarding step-2 removal + step-4 CTA** (P0.2).
4. **Loop guidance** (P1.5–7) — the demo-quality unlock.
5. P1.8–10 copy/guardrails, then P2 as a themed "polish week", P3 post-release.
