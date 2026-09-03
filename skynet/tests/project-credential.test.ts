// A project can be pinned to specific keys (`enabledRunnerCredentialIds`). That
// was enforced where RUNNERS are acquired, so runs and reviews honoured it —
// but every LLM SIDE call (triage clarifications, brief grounding, crystallize,
// decompose, board organisation, context condensing, backlog replenishment)
// resolved the workspace's default Anthropic key instead.
//
// The money half: a project moved onto a cheap compatible endpoint still paid
// Anthropic for all of those. The other half isn't money — "this project may
// only use key X" was simply not true, and that's a governance claim.
//
// These lock the rule down in the one place it now lives, and guard the way the
// gap actually appeared: sites added AFTER the credential was threaded through
// missed it, one at a time.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { secretService } from "../apps/server/src/secrets/index.js";
import { projectCredential } from "../apps/server/src/project-credential.js";

const WS = DEFAULT_WORKSPACE;
const OP = "jordan";

async function setup() {
  const store = new MemoryStore({ seed: false });
  await secretService.setKey(WS, "claude", "sk-workspace-default", OP, 1);
  const cheap = await secretService.createCredential(
    WS, "claude", "DeepSeek", "sk-deepseek", OP, 1, "https://api.deepseek.com/anthropic",
  );
  return { store, cheap };
}

let n = 0;
async function project(store: MemoryStore, enabledRunnerCredentialIds: string[]) {
  return store.putProject({
    id: `prj_${++n}`, workspaceId: WS, name: "Atlas", status: "active",
    createdAt: new Date().toISOString(), enabledRunnerCredentialIds,
  } as never);
}

describe("projectCredential — which key a project's side calls bill to", () => {
  let store: MemoryStore;
  let cheap: { id: string };
  beforeEach(async () => ({ store, cheap } = await setup()));

  it("uses the project's pinned credential, not the workspace default", async () => {
    const p = await project(store, [cheap.id]);
    const cred = await projectCredential(store, WS, p.id, "sonnet");
    expect(cred.apiKey).toBe("sk-deepseek");
    expect(cred.credentialId).toBe(cheap.id);
  });

  it("carries the endpoint too — the key alone would authenticate nothing at Anthropic", async () => {
    // This is the failure that produced a real 401: the right key sent to the
    // wrong vendor. A credential's baseUrl is not optional context.
    const p = await project(store, [cheap.id]);
    expect((await projectCredential(store, WS, p.id, "sonnet")).baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("prices against the endpoint's rates, so spend isn't reported at Anthropic prices", async () => {
    const p = await project(store, [cheap.id]);
    const { rates } = await projectCredential(store, WS, p.id, "deepseek-v4-flash");
    // Priced from the ENDPOINT, so a project on DeepSeek isn't billed on the
    // spend dashboard at Anthropic rates — the two differ by ~20x.
    expect(rates?.inputPerMTok).toBe(0.44);
  });

  it("falls back to the workspace default when the project pins nothing", async () => {
    // Empty is the DEFAULT and means "any key" — it must not be read as "no key".
    const p = await project(store, []);
    const cred = await projectCredential(store, WS, p.id, "sonnet");
    expect(cred.apiKey).toBe("sk-workspace-default");
    expect(cred.credentialId).toBe("claude");
  });

  it("falls back for a call that has no project at all", async () => {
    // draftCharter runs BEFORE a project exists; the workspace default is the
    // only answer available, and that's correct rather than a leftover.
    expect((await projectCredential(store, WS, null, "sonnet")).apiKey).toBe("sk-workspace-default");
  });

  it("falls back rather than throwing when the project id is stale", async () => {
    const cred = await projectCredential(store, WS, "prj_deleted", "sonnet");
    expect(cred.apiKey).toBe("sk-workspace-default");
  });

  it("picks deterministically when several keys are allowed", async () => {
    const other = await secretService.createCredential(WS, "claude", "Kimi", "sk-kimi", OP, 1);
    const p = await project(store, [cheap.id, other.id]);
    const a = await projectCredential(store, WS, p.id, "sonnet");
    const b = await projectCredential(store, WS, p.id, "sonnet");
    // Any member of an allowlist is legitimate by definition, so the choice is
    // arbitrary — but it must be STABLE, or an operator reading a bill can't
    // answer "which key paid for this".
    expect(a.credentialId).toBe(b.credentialId);
    expect(a.apiKey).toBe("sk-deepseek");
  });
});

describe("no LLM side call resolves the workspace default behind the rule's back", () => {
  // The regression guard that matches how this broke: the credential was
  // threaded through ~20 sites, then later work added new ones that resolved
  // `secretService.resolve(ws, "claude")` directly. A grep is a blunt test, but
  // it's the one that would have caught it.
  for (const file of ["operations.ts", "orchestrator.ts", "steward/assistant.ts"]) {
    it(`${file} routes project-scoped asks through projectCredential`, () => {
      const src = readFileSync(new URL(`../apps/server/src/${file}`, import.meta.url), "utf8");
      // The workspace dock genuinely has no project in focus, and says so on the
      // line above; everything else must go through the helper.
      const offenders = src
        .split("\n")
        .map((line, i, all) => [line, all.slice(Math.max(0, i - 4), i).join("\n")] as const)
        .filter(([line]) => /secretService\.resolve\(\s*\w+\s*,\s*"claude"\s*\)/.test(line))
        // An exemption has to state WHY in the comment right above it.
        .filter(([, preceding]) => !/no project in focus/.test(preceding));
      expect(offenders.map(([l]) => l.trim())).toEqual([]);
    });
  }
});
