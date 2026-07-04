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
];
