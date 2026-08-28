// A credential can name a Claude-compatible endpoint, so "which credential" is
// how a runner moves to a cheaper vendor. That made the edit form's missing Key
// picker a real gap: repointing an existing runner meant delete-and-recreate,
// which throws away its task history.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { secretService } from "../apps/server/src/secrets/index.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("repointing an existing runner at another credential", () => {
  let ops: Operations;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub) });
  });

  const addRunner = async (provider: ProviderId = "claude") =>
    ops.configureRunner(DEFAULT_WORKSPACE, { provider, model: "sonnet-5", name: "r1" });

  it("moves a runner onto a named credential", async () => {
    const runner = await addRunner();
    const cred = await secretService.createCredential(DEFAULT_WORKSPACE, "claude", "deepseek", "sk-x", "op", 1, "https://api.deepseek.com/anthropic");
    const updated = await ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: cred.id });
    expect(updated.credentialId).toBe(cred.id);
  });

  it("clears back to the provider's default key", async () => {
    const runner = await addRunner();
    const cred = await secretService.createCredential(DEFAULT_WORKSPACE, "claude", "deepseek", "sk-x", "op", 2, "https://api.deepseek.com/anthropic");
    await ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: cred.id });
    const cleared = await ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: null });
    expect(cleared.credentialId).toBeNull();
  });

  it("refuses a credential belonging to a DIFFERENT provider", async () => {
    // Without this you could point a Claude runner at a GitHub or Fly token —
    // authenticating nothing, and failing only once a real run started.
    const runner = await addRunner("claude");
    const gh = await secretService.createCredential(DEFAULT_WORKSPACE, "github", "pat", "ghp_x", "op", 3);
    await expect(ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: gh.id })).rejects.toThrow(/github/i);
  });

  it("refuses a credential that doesn't exist", async () => {
    const runner = await addRunner();
    await expect(ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: "cred-nope" })).rejects.toThrow(/unknown credential/i);
  });

  it("leaves the credential alone when the patch doesn't mention it", async () => {
    const runner = await addRunner();
    const cred = await secretService.createCredential(DEFAULT_WORKSPACE, "claude", "deepseek", "sk-x", "op", 4, "https://api.deepseek.com/anthropic");
    await ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { credentialId: cred.id });
    const renamed = await ops.updateAgent(DEFAULT_WORKSPACE, runner.id, { name: "renamed" });
    expect(renamed.credentialId).toBe(cred.id);
  });
});

describe("the fleet idle row is a fixed grid", () => {
  it("keeps the endpoint chip inside the name cell", () => {
    // .fleet-idle-row is `grid-template-columns: 1fr auto auto auto auto` —
    // exactly five children. A sixth top-level child lands in an implicit sixth
    // cell and wraps the row's action buttons onto a line of their own, which is
    // what shipped. The chip therefore belongs INSIDE the name button.
    const src = read("../apps/web/src/views/fleet.tsx");
    const row = src.slice(src.indexOf('<div className="fleet-idle-row">'), src.indexOf('className="fleet-idle-tasks'));
    expect(row).toContain("<EndpointChip");
    // ...and before the name button closes, not after it.
    expect(row.indexOf("<EndpointChip")).toBeLessThan(row.indexOf("</button>"));
  });

  it("every ConfigForm save path persists the credential", () => {
    // There are two inline editors — the card and the idle roster — and only one
    // was updated at first, so a vendor switch made from the idle row silently
    // saved the new MODEL against the old credential. That half-state is worse
    // than not offering the switch at all.
    const src = read("../apps/web/src/views/fleet.tsx");
    const saves = [...src.matchAll(/updateAgent\(r\.id, \{ model: u\.model[^}]*\}/g)].map((m) => m[0]);
    expect(saves.length).toBeGreaterThan(1);
    for (const call of saves) expect(call, `a ConfigForm save drops credentialId: ${call}`).toContain("credentialId");
  });

  it("still declares five grid columns, so the guard above stays meaningful", () => {
    const css = read("../apps/web/src/styles.css");
    const rule = css.slice(css.indexOf(".fleet-idle-row {"), css.indexOf(".fleet-idle-row:last-child"));
    expect(rule).toContain("grid-template-columns: 1fr auto auto auto auto");
  });
});
