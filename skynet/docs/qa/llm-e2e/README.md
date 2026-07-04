# LLM-driven, non-deterministic E2E

A complement to the deterministic Vitest suite. Instead of asserting known paths,
an LLM **driver** is given a persona + open-ended goal and a set of Skynet API
tools, and decides for itself how to exercise the running system — so each run
takes a different path and surfaces things nobody wrote an assertion for. An LLM
**judge** then scores the run's transcript + final server state against the
scenario's acceptance criteria and emits structured defects.

```
 scenarios.ts        run.ts (driver loop)              run.ts (judge)
 persona + goal  ──▶  Claude picks tool calls  ──▶  real HTTP to Skynet API
 + acceptance         (non-deterministic)            │
                                                      ▼
                              transcript + final /api/snapshot,/api/audit
                                                      │
                                                      ▼
                              Claude judge ──▶ {passed, defects[], notes}
```

## Why both kinds of tests
- **Deterministic (Vitest):** fast, stable, merge-blocking; guards regressions on known contracts.
- **LLM-driven (this):** exploratory; varies actions, invents edge cases, catches interaction bugs
  (e.g. double-assign orphaning an agent, misleading chat replies) that fixed scripts wouldn't try.
  Run it nightly / pre-release, not as a hard merge gate (it's non-deterministic and costs tokens).

## Run
```bash
# 1) start a seeded server
STORE=memory BUS=memory SESSIONS=memory AUTH_REQUIRED=true SKYNET_SEED=true \
  PORT=8093 pnpm --filter @skynet/server dev &

# 2) drive it with LLMs (from skynet/)
ANTHROPIC_API_KEY=sk-... BASE=http://localhost:8093 \
  pnpm test:llm-e2e
```
Exit code `0` when every scenario's judge PASSes with no High/Med defects, else `1`.
Without `ANTHROPIC_API_KEY` it prints a skip and exits `0` (so it never breaks CI until
wired into a credentialed job).

## Config (env)
| var | default | purpose |
|-----|---------|---------|
| `BASE` | `http://localhost:8093` | server under test |
| `ANTHROPIC_API_KEY` | — | required to actually run |
| `LLM_E2E_DRIVER_MODEL` | `claude-sonnet-4-6` | the explorer |
| `LLM_E2E_JUDGE_MODEL` | `claude-opus-4-8` | the grader |
| `LLM_E2E_MAX_TURNS` | `24` | tool-call budget per scenario |

## Add coverage
Append a persona to `scenarios.ts` — `{ name, persona, goal, token, acceptance }`.
The driver gets the whole tool-set (`get_snapshot`, `resolve_hitl`, `create_project`,
`assign_task`, `add_runner`, `login/logout`, and a `raw_request` escape hatch for
negative probing); keep the `acceptance` criteria specific so the judge is strict.

## Determinism & safety
- Non-deterministic by design (LLM temperature + free action choice). Treat failures as
  **leads to confirm**, then encode confirmed bugs as deterministic Vitest regressions.
- Point it only at a disposable seeded instance (`STORE=memory SKYNET_SEED=true`); the
  driver mutates real state and the adversarial persona probes auth/tenancy.
