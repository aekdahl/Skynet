# evals — LLM-judged acceptance suite

Behavioral evals: run a real agent through a scenario, capture what it did, and have a
**judge model** score it against a rubric. The counterpart to the deterministic `tests/`
suite. Full rationale + the scenario catalog: [`../docs/llm-acceptance.md`](../docs/llm-acceptance.md).

**This folder is outside the pnpm workspace on purpose** — `pnpm -r typecheck`, `pnpm build`,
and `vitest` never touch it. It runs on demand, costs tokens, and is non-deterministic.

## Layout
- `scenarios.ts` — the scenarios (task + `fixture` + rubric, some with scripted HITL `replies`).
- `judge.ts` — the LLM-as-judge. Runs through the runner-sdk's `oneShotText` (→ the `claude`
  CLI), the **same transport a live runner uses** — so it authenticates identically and works
  both standalone and nested inside a Claude Code session (where a raw `fetch` to the API has
  no egress). Returns a strict-JSON verdict we parse.
- `executor.ts` — boots the real orchestrator in-process against a throwaway git repo,
  lays down the scenario's fixture, assigns the task, resolves HITL gates from the scenario's
  `replies`, and captures artifacts.
- `types.ts` — `Scenario` / `Artifacts` / `Verdict` / `Executor`.
- `run.ts` — CLI.

## Real runs only
These evals run a **real agent** — that's the whole point. Do **not** use `RUNNER=mock`
here: a canned runner fabricates a diff and the judge grades a fiction. Mock belongs in the
deterministic `tests/` (vitest), never in an eval. Leave `RUNNER` unset so the fleet runner's
own provider executes, with a Claude credential present.

## Use
```bash
# list the catalog
tsx evals/run.ts list

# run a scenario for real (executor drives the agent) and judge it
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts run bugfix-failing-test   # one, or `run all`

# capture a run's artifacts without judging (branch diff, log, HITL, status, perf)
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts exec bugfix-failing-test > artifacts.json

# judge a previously-captured artifacts file (iterate the judge without re-running the agent)
ANTHROPIC_API_KEY=sk-… tsx evals/run.ts judge bugfix-failing-test ./artifacts.json
```

Judge model: `SKYNET_JUDGE_MODEL` (default `opus`). Per-scenario timeout:
`SKYNET_EVAL_TIMEOUT_MS` (default 180s; use ~600000 for `run all`, some agents take minutes).

## How the executor runs
- Boots `MemoryStore` + `InProcessBus` + `Hub` + `Orchestrator` against a temp git repo
  (fresh `main` base, with a realistic `.gitignore` so agent tooling doesn't pollute the diff).
  Env is set before importing config (import-time capture).
- Per scenario: resets `main` to the clean base, writes + commits the scenario's `fixture`,
  creates a fleet runner (`SKYNET_EVAL_PROVIDER`, default `claude`) + project + task, then
  `assignTask`.
- Subscribes to the bus and resolves each HITL gate from the scenario's `replies` (consumed
  in order; default **approve** once exhausted), waits for a terminal `done` (or
  `SKYNET_EVAL_TIMEOUT_MS`), then captures the diff / log / HITL / status / wall-clock.

Non-deterministic by nature — run N times and track a pass rate; don't gate a PR on a single
run. `run all` is resilient: one scenario erroring doesn't abort the sweep.
