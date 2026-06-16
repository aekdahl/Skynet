# Project New IDE — working notes

- App: **Tower — Mission Control.html** (views: Ledger / Subway / Roster / Flight Deck / Timeline / Inbox; drill-down to project + agent detail with Live Preview).
- Mobile strategy: **bring the main app to mobile as a PWA** (responsive views + installable, Inbox-first). The separate "Tower Mobile — Push to Approve.html" mock is reference-only, superseded by this direction. Push notifications remain relevant as the PWA's entry point into the Inbox.
- Visual language: dark mission-control aesthetic (Space Grotesk / IBM Plex Mono, amber accent). Scandinavian-light restyle was considered and explicitly skipped.
- Codebase is shown code-agnostically: module names (Shared UI, Billing…) everywhere; file paths/diffs only inside diff-review actions.
- No keyboard shortcuts (removed on request).
- CRUD is live: Projects (create/edit/delete on Projects + project page), Tasks (add/edit/delete backlog on project page; Assign spins up a real agent), Fleet tab (configure/retire runners across providers: Claude, Codex, Gemini, Cursor, Copilot — each with its own model list). Provider glyphs (✱◌✦▎◈) show on agent cards. Busy runners can't be retired.
- Live state lifted to app.jsx (projects/agents/fleet); views.jsx reads window.LIVE_PROJECTS for projNameOf.
