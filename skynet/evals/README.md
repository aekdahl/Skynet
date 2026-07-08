# evals — LLM-judged acceptance suite

Behavioral evals: run a real agent through a scenario, capture what it did, and have a
**judge model** score it against a rubric. The counterpart to the deterministic `tests/`
suite. Full rationale + the scenario catalog: [`../docs/llm-acceptance.md`](../docs/llm-acceptance.md).

**This folder is outside the pnpm workspace on purpose** — `pnpm -r typecheck`, `pnpm build`,
and `vitest` never touch it. It runs on demand, costs tokens, and is non-deterministic.

## Layout
- `scenarios.ts` — the 20 scenarios (task + rubric) for this release.
- `judge.ts` — the LLM-as-judge (one Anthropic Messages call via `fetch`, structured verdict).
- `executor.ts` — boots the real orchestrator in-process against a throwaway git repo,
  assigns the scenario task, auto-resolves HITL gates, and captures artifacts.
- `types.ts` — `Scenario` / `Artifacts` / `Verdict` / `Executor`.
- `run.ts` — CLI.

## Use
```bash
# list the catalog
tsx evals/run.ts list

# smoke-test the executor end-to-end with the mock runner — NO key needed
RUNNER=mock tsx evals/run.ts exec bugfix-failing-test

# run a scenario for real (executor drives the agent) and judge it
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts run bugfix-failing-test   # one, or `run all`

# judge a previously-captured artifacts file
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts judge bugfix-failing-test ./artifacts.json
```

`exec` prints an [`Artifacts`](./types.ts) object (branch diff, agent log, HITL items,
final status, perf counters). Pipe it to a file, then `judge` it.

Judge model: `SKYNET_JUDGE_MODEL` (default `claude-opus-4-8`).

## How the executor runs
- Boots `MemoryStore` + `InProcessBus` + `Hub` + `Orchestrator` against a temp git repo
  (fresh `main` base). Env is set before importing config (import-time capture).
- Creates a fleet runner (`SKYNET_EVAL_PROVIDER`, default `claude`) + project + task, then
  `assignTask`. `RUNNER=mock` overrides execution to the mock runner (keyless smoke test);
  leave `RUNNER` unset for the runner's own provider (needs `ANTHROPIC_API_KEY`).
- Subscribes to the bus and **auto-approves every HITL** (a richer per-scenario reply
  script can key off `scenario.hitl` later), waits for a terminal `done` (or
  `SKYNET_EVAL_TIMEOUT_MS`, default 180s), then captures the diff/log/HITL/status.

**Smoke-tested** with `RUNNER=mock` (assign → gate → auto-approve → done → artifacts).
Non-deterministic for real runs — run N times and track a pass rate; don't gate a PR on
a single run.
