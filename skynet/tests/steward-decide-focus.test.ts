// Steward decides which project the operator means (a MODEL judgment) instead of
// a name-matching regex, and asks when it's ambiguous. parseFocusDecision is the
// pure validator over the model's structured reply — the id must be real, and a
// concrete project wins over a question.
import { describe, it, expect } from "vitest";
import { parseFocusDecision } from "../apps/server/src/steward/assistant.js";

const ids = new Set(["p-1", "p-2"]);

describe("parseFocusDecision", () => {
  it("takes a valid projectId (and clears any clarify)", () => {
    expect(parseFocusDecision('{"projectId":"p-1","clarify":null}', ids)).toEqual({ projectId: "p-1", clarify: null });
  });

  it("returns the clarify question when no project is chosen", () => {
    expect(parseFocusDecision('{"projectId":null,"clarify":"Which one — Alpha or Bravo?"}', ids)).toEqual({
      projectId: null,
      clarify: "Which one — Alpha or Bravo?",
    });
  });

  it("drops an unknown projectId (never focuses a made-up id)", () => {
    expect(parseFocusDecision('{"projectId":"p-nope","clarify":null}', ids)).toEqual({ projectId: null, clarify: null });
  });

  it("prefers a concrete project over a clarify if the model sent both", () => {
    expect(parseFocusDecision('{"projectId":"p-2","clarify":"or maybe p-1?"}', ids)).toEqual({ projectId: "p-2", clarify: null });
  });

  it("extracts the JSON even wrapped in prose", () => {
    expect(parseFocusDecision('Sure: {"projectId":"p-1"} — focusing it.', ids)).toEqual({ projectId: "p-1", clarify: null });
  });

  it("no decision on empty / non-JSON / neither field", () => {
    expect(parseFocusDecision("", ids)).toEqual({ projectId: null, clarify: null });
    expect(parseFocusDecision("just chatting", ids)).toEqual({ projectId: null, clarify: null });
    expect(parseFocusDecision('{"foo":1}', ids)).toEqual({ projectId: null, clarify: null });
  });
});
