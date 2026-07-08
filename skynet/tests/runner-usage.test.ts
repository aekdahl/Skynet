// usageFromJson distils best-effort token/cost totals out of the varied JSON
// shapes the vendor CLIs emit. It must never fabricate a zeroed row (returns
// null when no token count is present) but should tolerate nesting + aliases.
import { describe, it, expect } from "vitest";
import { usageFromJson } from "../packages/runner-sdk/src/cli-runner.js";

describe("usageFromJson", () => {
  it("maps flat input/output token fields", () => {
    expect(usageFromJson({ input_tokens: 100, output_tokens: 20, total_cost_usd: 0.5 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
      turns: 0,
      durationMs: null,
    });
  });

  it("reads prompt/completion aliases nested under usage", () => {
    const u = usageFromJson({ usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.01 } });
    expect(u).toMatchObject({ inputTokens: 7, outputTokens: 3, costUsd: 0.01 });
  });

  it("returns null when there is no token count (never a fake zero row)", () => {
    expect(usageFromJson({ type: "assistant", text: "hi" })).toBeNull();
    expect(usageFromJson({})).toBeNull();
  });

  it("keeps partials honest — missing cost/turns stay null/0", () => {
    expect(usageFromJson({ output_tokens: 42 })).toEqual({
      inputTokens: 0,
      outputTokens: 42,
      costUsd: null,
      turns: 0,
      durationMs: null,
    });
  });
});
