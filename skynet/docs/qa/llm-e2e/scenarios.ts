/**
 * LLM-E2E scenarios. Each is a persona + open-ended goal + acceptance criteria
 * the judge scores against. The driver chooses its own actions, so runs are
 * non-deterministic — add personas here to widen exploratory coverage.
 *
 * Tokens use the dev token map (DEV ONLY). `login` inside a run can swap to a
 * real session token. Two workspaces (cyberdyne, resistance) let the adversary
 * probe tenant isolation.
 */

export interface Scenario {
  name: string;
  persona: string;
  goal: string;
  token: string; // starting auth token
  acceptance: string;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "operator-hitl-lifecycle",
    persona: "an operator clearing the Inbox in the cyberdyne workspace",
    token: "dev-cyberdyne",
    goal:
      "Exercise the human-in-the-loop lifecycle: inspect the queue, resolve several items using DIFFERENT actions " +
      "(approve, reject, modify+guidance, option+optionIndex where options exist), then confirm each shows up in the " +
      "audit trail. Try chatting with and forking an agent. Probe: resolve a bogus id, resolve the same item twice.",
    acceptance:
      "Every valid resolve returns 2xx and appears in /api/audit with the correct action + operator. Re-resolving the " +
      "same item is idempotent (first decision wins; never overwritten). A bogus HITL id returns 404, not 500. Chat/fork " +
      "return sensible responses. No 500s.",
  },
  {
    name: "admin-workspace-setup",
    persona: "a new admin bootstrapping the (empty) resistance workspace",
    token: "dev-resistance",
    goal:
      "Stand up a workspace from empty: create a project, add tasks, add a fleet runner (pick a real provider+model from " +
      "list_providers), then assign a task and watch an agent appear (or handle a 409 no-idle-runner by adding one and " +
      "retrying). Edit and delete a task/project. Probe: create with empty name, assign with no idle runner.",
    acceptance:
      "Create/edit/delete persist (verified via get_snapshot). Assign either creates an agent (2xx) or returns 409 when no " +
      "idle runner, never 500. Empty/invalid inputs return 400. Deleted entities are gone on the next read. Everything stays " +
      "in the resistance workspace.",
  },
  {
    name: "adversary-auth-and-tenancy",
    persona: "an adversarial tester probing auth, tenant isolation, and input validation",
    token: "dev-cyberdyne",
    goal:
      "Try to break security: hit /api/* with no/garbage token (expect 401); login happy + bad-password paths; use a session " +
      "token then logout and reuse it. Attempt CROSS-TENANT access — take a cyberdyne id and try to read/mutate it as " +
      "resistance (via raw_request with the other dev token) and vice-versa. Send malformed bodies and hit unknown routes.",
    acceptance:
      "Unauthenticated /api/* → 401 (except POST /api/auth/login). Bad password → 401. A logged-out/expired session → 401. " +
      "Cross-workspace reads/mutations → 404 (never another tenant's data). Re-resolve is first-writer-wins. Malformed input " +
      "→ 400, unknown route → 404. No 500s and no cross-tenant leakage anywhere.",
  },

  // ── capability / GTM-claim coverage (LLM-judged, non-deterministic) ────────
  {
    name: "operator-local-folder-supervised-loop",
    persona: "an operator running a task on a project bound to a LOCAL folder (the desktop-first, no-GitHub path)",
    token: "dev-cyberdyne",
    goal:
      "Prove the supervised loop for a local project. Create a project with create_project passing repoPath (an absolute " +
      "folder) — confirm via get_snapshot the folder is recorded. Ensure fleet capacity (add_runner from list_providers), " +
      "add a task, assign it, and watch an agent appear. If a HITL gate is raised, inspect it and resolve it; confirm the " +
      "decision lands in get_audit. Try chatting with the agent about what it's doing.",
    acceptance:
      "The project records the local repoPath (worktree-per-agent mode). Assigning creates an agent (2xx) or 409 with no idle " +
      "runner (then succeeds after add_runner) — never 500. Any HITL gate requires an explicit resolve before work proceeds, " +
      "and every resolve appears in the audit with the right action+operator. Chat returns a sensible reply. Nothing implies " +
      "work happened without a human decision where a gate existed.",
  },
  {
    name: "operator-provider-keys-and-privacy",
    persona: "a privacy-conscious operator wiring up provider credentials",
    token: "dev-cyberdyne",
    goal:
      "Configure and scrutinize provider keys. Pick a provider that is NOT currently available (list_providers), set_secret " +
      "for it, and confirm via list_providers that the vendor becomes available. Then AGGRESSIVELY try to read the raw key " +
      "back — via list_secrets, get_snapshot, list_providers, and raw_request to any plausible endpoint. Finally delete_secret " +
      "and confirm the vendor reverts.",
    acceptance:
      "Setting a key flips that vendor to available; deleting it reverts (unless an env key backs it). The plaintext key is " +
      "NEVER returned by any endpoint — only a last4 fingerprint + metadata. No snapshot/provider/secret payload leaks the key " +
      "or ciphertext. Deleting is reflected on the next read. No 500s.",
  },
  {
    name: "operator-archive-declutter",
    persona: "an operator tidying a busy project board",
    token: "dev-cyberdyne",
    goal:
      "Exercise archiving. Find (or create+assign to get) an agent, archive_agent it, and confirm via get_snapshot it is " +
      "flagged archived (hidden from the live board) yet still retained. Then restore it (archive_agent archived:false) and " +
      "confirm it returns. Probe: archive a bogus agent id.",
    acceptance:
      "Archiving sets the agent archived and it is no longer part of the live board, but the record is retained and fully " +
      "restorable — no data loss. Restore reverses it. A bogus id fails gracefully (4xx, not 500).",
  },
  {
    name: "operator-github-guardrails",
    persona: "an operator reviewing the GitHub write guardrails before enabling agents on a repo",
    token: "dev-cyberdyne",
    goal:
      "Inspect and adjust safety. Read the connection with get_github and confirm the guardrails (prOnly, noForcePush, " +
      "moduleAllowlist, approveBeforePush) are ON by default. Toggle one off via raw_request to PUT /api/github/safety and " +
      "confirm it persists on the next get_github, then turn it back on.",
    acceptance:
      "All four guardrails default to ON. A toggle persists and is reflected on re-read. get_github always returns a coherent " +
      "connection object (connected flag, auth mode, appConfigured/brokerConfigured booleans). No 500s.",
  },
  {
    name: "adversary-secret-and-guardrail-probing",
    persona: "an adversary trying to exfiltrate credentials or bypass the write guardrails",
    token: "dev-cyberdyne",
    goal:
      "Attack the sensitive surfaces. Try to read any provider key in plaintext through every endpoint you can think of " +
      "(list_secrets, get_snapshot, raw_request to /api/secrets, guessed paths). Try to set a secret or read guardrails as the " +
      "OTHER tenant (raw_request with the dev-resistance token). Try to disable guardrails or push without approval via " +
      "raw_request. Send tampered/oversized bodies.",
    acceptance:
      "No path returns a plaintext key or ciphertext — ever. Cross-tenant secret/guardrail reads or writes → 404/403, never " +
      "another tenant's data. Guardrails cannot be bypassed without an explicit, audited operator action. Malformed input → 400, " +
      "unknown route → 404. No 500s.",
  },
];
