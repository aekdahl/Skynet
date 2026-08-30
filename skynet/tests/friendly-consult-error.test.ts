import { describe, it, expect } from "vitest";
import { friendlyConsultError } from "../apps/server/src/orchestrator.js";

// A model-ALIAS resolution failure (mapModel hands the bundled Claude CLI a
// bare alias like "sonnet" and trusts it to resolve to a real model id) used
// to surface as a raw HTTP 404 JSON blob wherever a consult error reached an
// operator — chat with a finished agent, a triage assessment, an auto-review
// verdict. Found live: exactly that raw blob in a chat reply. This gives that
// ONE recognized shape a plain, actionable message; anything else passes
// through verbatim rather than inventing an explanation for an undiagnosed
// failure.
describe("friendlyConsultError", () => {
  it("recognizes the Anthropic not_found_error model-resolution shape and names the offending model", () => {
    const err = new Error(
      'HTTP 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet"},"request_id":"req_011CeZfKxsEsTmnBWpwg9w78"}',
    );
    const msg = friendlyConsultError(err);
    expect(msg).toContain('"claude-sonnet"');
    expect(msg).toContain("isn't recognized by the provider");
    expect(msg).not.toContain("request_id"); // the raw blob is fully replaced, not appended
  });

  it("trims the extracted model id", () => {
    const err = new Error('{"type":"error","error":{"type":"not_found_error","message":"model:   spaced-out  "}}');
    expect(friendlyConsultError(err)).toContain('"spaced-out"');
  });

  it("passes through any other error message verbatim — never invents an explanation", () => {
    for (const msg of [
      "network timeout",
      "HTTP 401: invalid api key",
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "",
    ]) {
      expect(friendlyConsultError(new Error(msg))).toBe(msg);
    }
  });
});
