// Coverage guard: every user-facing client API should be exercised by an in-app
// QA surface (a Simulation journey or an Acceptance check) — OR be explicitly
// allowlisted with a reason. This turns "did we forget to cover the new endpoint?"
// from a manual diff into a failing test. When you add a client fn, you either
// reference it from simulation.ts / acceptance.ts or add it to ALLOW below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const client = read("../apps/web/src/lib/client.ts");
const exported = [...client.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]!);

// Both QA surfaces import `* as api`, so references read as `api.<name>`.
const surfaces = ["../apps/web/src/lib/simulation.ts", "../apps/web/src/lib/acceptance.ts"]
  .map(read)
  .join("\n");
const referenced = new Set([...surfaces.matchAll(/api\.(\w+)/g)].map((m) => m[1]!));

// Exports NOT expected to have a journey/acceptance check. Keep this SHORT and
// justified — each entry is a deliberate "won't cover here" decision.
const ALLOW = new Set<string>([
  // transport / plumbing
  "connect", // raw WebSocket
  "login", // real email/password → session; journeys use the dev-token path, so there's no offline flow to exercise it
  "fetchEvals", "runEval", "fetchEvalJob", "judgeSimulation", // eval + judge machinery
  // needs a live GitHub remote / OS dialog — can't run offline in a journey
  "browseFolder",
  "startGithubDevice", "pollGithubDevice", "fetchGithubInstallations",
  "fetchGithubInstallationRepos", "connectGithub", "disconnectGithub",
  "cloneProjectRepo", // clones a connected GitHub repo — needs a live remote + token
  // destructive bulk variants (the per-record paths ARE covered)
  "archiveAllAudit", "clearAudit",
  // low-value control-plane (runner rename/model tweak)
  "updateAgent",
  // streaming variant of sendAgentMessage (which IS journey-covered) — same
  // chat surface, just delta-rendered; no separate journey needed.
  "streamAgentMessage",
  // "ask about this project" assistant (+ its streaming variant) — a UI-only
  // conversational surface with no fleet journey; needs a real provider key.
  "projectChat", "streamProjectChat",
  // live preview (Phase-1 v0) — spawns a real dev server + iframes it; a
  // stateful UI control surface with no offline journey (needs a repo + toolchain).
  "previewStatus", "previewStart", "previewStop", "previewRestart", "previewRefresh",
  // auth primitive (POST /api/auth/login) — the local/desktop build runs
  // open-auth (dev tokens), so no fleet journey signs in; auth is guarded by
  // auth-hardening.test.ts, not an operator journey.
  "login",
  // read-only doc render for the Roadmap page — no operator journey to exercise
  "fetchRoadmap",
  // auth handshake — needs live operator credentials + a session token exchange,
  // so it can't run in an offline journey (the login screen exercises it live)
  "login",
  // desktop Advanced settings (env editor + engine restart) — a desktop-only
  // control-plane surface with no in-app operator journey
  "fetchEnvSettings", "saveEnvSettings", "restartEngine",
]);

describe("client API coverage", () => {
  it("every exported client API is exercised by a journey/acceptance check (or allowlisted)", () => {
    const uncovered = exported.filter((n) => !referenced.has(n) && !ALLOW.has(n));
    expect(
      uncovered,
      `Unexercised client APIs — add a Simulation journey / Acceptance check, or allowlist with a reason:\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (every allowlisted name still exists + is still unreferenced)", () => {
    const stale = [...ALLOW].filter((n) => !exported.includes(n) || referenced.has(n));
    expect(stale, `Stale ALLOW entries (now covered or removed) — drop them:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
