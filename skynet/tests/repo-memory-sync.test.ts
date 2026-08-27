// v4: repo-native memory sync — projecting Skynet's portable project memory
// (Project.contextSummary) into CLAUDE.md / .cursor/rules / Copilot
// instructions inside a run's checkout. This file pins the pure filesystem
// behavior in isolation; tests/repo-memory-sync-wiring.test.ts pins that
// orchestrator.assign() actually calls it with the right cwd/memory.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncRepoNativeMemory,
  CLAUDE_MD_PATH,
  CURSOR_RULE_PATH,
  COPILOT_INSTRUCTIONS_PATH,
} from "../apps/server/src/repo-memory-sync.js";

describe("syncRepoNativeMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-memory-sync-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-op when there's no memory to project (null/blank)", async () => {
    await syncRepoNativeMemory(dir, null);
    await syncRepoNativeMemory(dir, "   ");
    expect(existsSync(join(dir, CLAUDE_MD_PATH))).toBe(false);
    expect(existsSync(join(dir, CURSOR_RULE_PATH))).toBe(false);
    expect(existsSync(join(dir, COPILOT_INSTRUCTIONS_PATH))).toBe(false);
  });

  it("creates all three vendor files from scratch, carrying the memory text", async () => {
    await syncRepoNativeMemory(dir, "The billing service owns invoicing; never touch it from checkout.");

    const claude = readFileSync(join(dir, CLAUDE_MD_PATH), "utf8");
    expect(claude).toContain("The billing service owns invoicing");
    expect(claude).toContain("skynet:memory:start");
    expect(claude).toContain("skynet:memory:end");

    const copilot = readFileSync(join(dir, COPILOT_INSTRUCTIONS_PATH), "utf8");
    expect(copilot).toContain("The billing service owns invoicing");

    const cursor = readFileSync(join(dir, CURSOR_RULE_PATH), "utf8");
    expect(cursor).toContain("The billing service owns invoicing");
    expect(cursor).toContain("alwaysApply: true");
  });

  it("preserves an operator's own CLAUDE.md content outside the marked block", async () => {
    writeFileSync(join(dir, CLAUDE_MD_PATH), "# My project\n\nHand-written setup notes.\n");

    await syncRepoNativeMemory(dir, "Fact one.");

    const claude = readFileSync(join(dir, CLAUDE_MD_PATH), "utf8");
    expect(claude).toContain("# My project");
    expect(claude).toContain("Hand-written setup notes.");
    expect(claude).toContain("Fact one.");
  });

  it("re-syncing replaces only the marked block, leaving hand-written content and updating the memory", async () => {
    writeFileSync(join(dir, CLAUDE_MD_PATH), "# My project\n\nHand-written setup notes.\n");
    await syncRepoNativeMemory(dir, "Fact one.");
    await syncRepoNativeMemory(dir, "Fact two.");

    const claude = readFileSync(join(dir, CLAUDE_MD_PATH), "utf8");
    expect(claude).toContain("# My project");
    expect(claude).toContain("Hand-written setup notes.");
    expect(claude).toContain("Fact two.");
    expect(claude).not.toContain("Fact one.");
    // Only one marked block, not one appended per sync.
    expect(claude.split("skynet:memory:start").length - 1).toBe(1);
  });

  it("creates the .cursor/rules and .github directories as needed", async () => {
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);

    await syncRepoNativeMemory(dir, "Fact one.");

    expect(existsSync(join(dir, ".cursor", "rules"))).toBe(true);
    expect(existsSync(join(dir, ".github"))).toBe(true);
  });

  it("re-syncing overwrites the whole Cursor rule file (Skynet owns that filename outright)", async () => {
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, CURSOR_RULE_PATH), "stale content that should be fully replaced");

    await syncRepoNativeMemory(dir, "Fresh memory.");

    const cursor = readFileSync(join(dir, CURSOR_RULE_PATH), "utf8");
    expect(cursor).not.toContain("stale content");
    expect(cursor).toContain("Fresh memory.");
  });
});
