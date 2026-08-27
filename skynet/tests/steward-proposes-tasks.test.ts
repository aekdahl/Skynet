// Steward may now propose tasks that the DISCUSSION produced, not only ones it
// was explicitly told to create. The prompt used to forbid this outright
// ("include it ONLY for change requests, never for questions, summaries, or
// chat"), which meant agreeing on four things with Steward and then having to
// ask it a second time to write them down.
//
// Relaxing that makes duplicate proposals the obvious new failure mode — talk
// about the same feature twice, get the same chips again — so the guard against
// it is code, not a sentence in a prompt the model may or may not honour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateProjectAction, sameTaskText, type ProjectActionContext } from "../apps/server/src/steward/assistant.js";

const ctx = (titles: string[]): ProjectActionContext => ({
  project: { id: "p1", name: "P" },
  tasks: titles.map((text, i) => ({ id: `t${i}`, text, state: "todo" as const })),
});

describe("add_task proposals are deduped against the board", () => {
  it("proposes a genuinely new task", () => {
    const a = validateProjectAction({ kind: "add_task", text: "Add rate limiting" }, ctx(["Fix login"]));
    expect(a).toMatchObject({ kind: "add_task", text: "Add rate limiting" });
  });

  it("drops one that already exists verbatim", () => {
    expect(validateProjectAction({ kind: "add_task", text: "Fix login" }, ctx(["Fix login"]))).toBeNull();
  });

  it("drops one that differs only in surface form", () => {
    // The same intent comes back differently worded across two turns of a
    // conversation; that's the case this exists for.
    for (const variant of ["fix login", "  Fix   login  ", "Fix login.", "FIX LOGIN!"]) {
      expect(validateProjectAction({ kind: "add_task", text: variant }, ctx(["Fix login"])), variant).toBeNull();
    }
  });

  it("does NOT drop a task that merely resembles an existing one", () => {
    // Being too clever here is the worse error: silently swallowing real work
    // is invisible, whereas a duplicate chip is merely annoying and one click
    // to dismiss.
    const near = ["Fix login redirect", "Fix logout", "Login"];
    for (const text of near) {
      expect(validateProjectAction({ kind: "add_task", text }, ctx(["Fix login"])), text).not.toBeNull();
    }
  });

  it("dedupes against tasks in any column, not just todo", () => {
    const c: ProjectActionContext = {
      project: { id: "p1", name: "P" },
      tasks: [{ id: "t1", text: "Ship the export button", state: "done" }],
    };
    expect(validateProjectAction({ kind: "add_task", text: "Ship the export button" }, c)).toBeNull();
  });

  it("still refuses an empty title", () => {
    expect(validateProjectAction({ kind: "add_task", text: "   " }, ctx([]))).toBeNull();
  });
});

describe("sameTaskText", () => {
  it("ignores case, spacing and trailing punctuation", () => {
    expect(sameTaskText("Add caching", "  add   caching. ")).toBe(true);
  });

  it("keeps distinct work distinct", () => {
    expect(sameTaskText("Add caching", "Add caching to the API")).toBe(false);
    expect(sameTaskText("Add caching", "Remove caching")).toBe(false);
  });

  it("doesn't strip INTERIOR punctuation, which changes meaning", () => {
    expect(sameTaskText("Fix: login", "Fix login")).toBe(false);
  });
});

describe("the system prompt actually tells Steward to do this", () => {
  it("permits proposing from a discussion, and names what not to propose for", () => {
    // The behaviour lives in a prompt string — nothing type-checks it — so this
    // pins the intent rather than letting a later edit quietly restore
    // "only on explicit request" and silently switch the feature back off.
    const src = readFileSync(fileURLToPath(new URL("../apps/server/src/steward/assistant.ts", import.meta.url)), "utf8");
    expect(src).toContain("DISCUSSION ITSELF produced concrete work");
    expect(src).toContain("already on the board");
    expect(src).not.toContain("Include it ONLY for change requests");
  });
});
