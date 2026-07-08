# evals — LLM-judged acceptance suite

Behavioral evals: run a real agent through a scenario, capture what it did, and have a
**judge model** score it against a rubric. The counterpart to the deterministic `tests/`
suite. Full rationale + the scenario catalog: [`../docs/llm-acceptance.md`](../docs/llm-acceptance.md).

**This folder is outside the pnpm workspace on purpose** — `pnpm -r typecheck`, `pnpm build`,
and `vitest` never touch it. It runs on demand, costs tokens, and is non-deterministic.

## Layout
- `scenarios.ts` — the 20 scenarios (task + rubric) for this release.
- `judge.ts` — the LLM-as-judge (one Anthropic Messages call via `fetch`, structured verdict).
- `types.ts` — `Scenario` / `Artifacts` / `Verdict` / `Executor`.
- `run.ts` — CLI.

## Use
```bash
# list the catalog
tsx evals/run.ts list

# judge a captured run — works today, only needs a key
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts judge bugfix-failing-test ./artifacts.json

# full auto-run (once an Executor is wired)
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts run all
```

`artifacts.json` is an [`Artifacts`](./types.ts) object — the branch diff, agent log,
HITL items, final status, and perf counters captured from a run.

Judge model: `SKYNET_JUDGE_MODEL` (default `claude-opus-4-8`).

## Wiring the Executor (next step)
`run` needs something that actually drives an agent. Add `evals/executor.ts`:

```ts
import type { Executor } from "./types.js";
export function makeExecutor(): Executor {
  return {
    async run(scenario) {
      // provision a runner → assignTask(scenario.task) → script HITL replies →
      // collect: git diff of the agent branch, the agent log, HITL items, PR, status,
      // and turns/tokens/wallMs. Return as Artifacts.
      return { /* … */ };
    },
  };
}
```

Run with `RUNNER` unset (per-fleet provider) or `RUNNER=claude`, against a throwaway git
fixture per scenario. Non-deterministic — run N times and track a pass rate; don't gate a
PR on a single run.
