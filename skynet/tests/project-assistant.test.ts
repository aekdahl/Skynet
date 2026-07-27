// The in-app project assistant can now propose a task (confirm-first). The model
// appends a final-line {"proposeTask":"…"} only when the operator clearly asks to
// create one; splitProposedTask peels that off the shown reply. These are the
// pure-parse guarantees the UI's confirm chip relies on.
import { describe, it, expect } from "vitest";
import { splitProposedTask } from "../apps/server/src/project-assistant.js";

describe("splitProposedTask", () => {
  it("returns the whole text as reply when there is no proposal", () => {
    const r = splitProposedTask("The roadmap has 3 open items: A, B, C.");
    expect(r.proposeTask).toBeNull();
    expect(r.reply).toBe("The roadmap has 3 open items: A, B, C.");
  });

  it("splits a trailing proposeTask off the reply", () => {
    const raw = 'Sure — I can add that.\n{"proposeTask":"Add dark-mode toggle to settings"}';
    const r = splitProposedTask(raw);
    expect(r.proposeTask).toBe("Add dark-mode toggle to settings");
    expect(r.reply).toBe("Sure — I can add that.");
  });

  it("tolerates a code-fenced JSON tail", () => {
    const raw = 'Will do.\n```json\n{"proposeTask":"Fix login redirect loop"}\n```';
    const r = splitProposedTask(raw);
    expect(r.proposeTask).toBe("Fix login redirect loop");
    expect(r.reply).toBe("Will do.");
  });

  it("supplies a fallback reply when the model sent only the JSON", () => {
    const r = splitProposedTask('{"proposeTask":"Write onboarding docs"}');
    expect(r.proposeTask).toBe("Write onboarding docs");
    expect(r.reply.length).toBeGreaterThan(0); // never an empty bubble
  });

  it("ignores an empty or non-string proposeTask", () => {
    expect(splitProposedTask('done.\n{"proposeTask":""}').proposeTask).toBeNull();
    expect(splitProposedTask('done.\n{"proposeTask":123}').proposeTask).toBeNull();
  });

  it("does not mistake a JSON object in prose for a proposal", () => {
    const raw = 'The config looks like {"port": 8080} in the file.';
    const r = splitProposedTask(raw);
    expect(r.proposeTask).toBeNull();
    expect(r.reply).toBe(raw);
  });
});
