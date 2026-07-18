// ─── LLM-judged acceptance runner (CLI) ────────────────────────────────────
//   tsx evals/run.ts list
//   tsx evals/run.ts judge <scenarioId> <artifacts.json>   (works today, needs a key)
//   tsx evals/run.ts run   <scenarioId|all>                (needs an Executor — see README)
//   tsx evals/run.ts calibrate                             (judge negative controls — no agent runs)
//   tsx evals/run.ts repeat <scenarioId> [N]               (N real runs → pass rate + score spread)
//
// Machine-readable variants used by the in-app Acceptance view (see the server's
// evals routes) — these emit JSON on stdout, never human prose:
//   tsx evals/run.ts catalog-json           → the scenario catalog, one JSON array
//   tsx evals/run.ts run-json <scenarioId>   → NDJSON: {type:"phase"} … {type:"result"|"error"}

import { readFileSync } from "node:fs";
import { SCENARIOS } from "./scenarios.js";
import { judge } from "./judge.js";
import type { Artifacts, Executor, Scenario, Verdict } from "./types.js";

function find(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) {
    console.error(`Unknown scenario "${id}". Run \`tsx evals/run.ts list\`.`);
    process.exit(1);
  }
  return s;
}

function report(scenario: Scenario, v: Verdict): void {
  const mark = v.pass ? "✓ PASS" : "✗ FAIL";
  console.log(`\n${mark}  ${scenario.id} — ${scenario.title}   (overall ${v.overall.toFixed(1)}/5)`);
  for (const d of v.dimensions) {
    console.log(`   ${d.pass ? "✓" : "✗"} ${d.dimension} ${d.score}/5 — ${d.rationale}`);
  }
  console.log(`   → ${v.summary}`);
}

async function loadExecutor(): Promise<Executor> {
  // Optional: drop an evals/executor.ts exporting `makeExecutor(): Executor` that
  // drives the orchestrator (provision runner → assign task → script HITL →
  // collect diff/log/PR). Until then, `run` is unavailable; `judge` works on
  // captured artifacts.
  try {
    // Variable specifier: the file is optional, so don't let it be a static
    // build-time dependency — it's resolved (or not) at runtime.
    const spec = "./executor.js";
    const mod = (await import(spec)) as { makeExecutor?: () => Executor };
    if (mod.makeExecutor) return mod.makeExecutor();
  } catch {
    /* no executor wired */
  }
  throw new Error(
    "No executor wired. Add evals/executor.ts exporting makeExecutor(): Executor,\n" +
      "or capture a run's artifacts to JSON and use: tsx evals/run.ts judge <id> <artifacts.json>",
  );
}

async function main(): Promise<void> {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (cmd === "list" || !cmd) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(28)} [${s.category}] ${s.title}`);
    console.log(`\n${SCENARIOS.length} scenarios. See docs/llm-acceptance.md.`);
    return;
  }

  if (cmd === "catalog-json") {
    // Machine-readable scenario catalog for the in-app Acceptance view. One JSON
    // array on a single line (no pretty-print) so the caller can grab it robustly.
    const catalog = SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      task: s.task,
      setup: s.setup ?? null,
      rubric: s.rubric,
    }));
    process.stdout.write(JSON.stringify(catalog) + "\n");
    return;
  }

  if (cmd === "run-json") {
    // Run one scenario end-to-end (real agent → judge) and stream NDJSON so the
    // server can surface live phase + a final verdict in the UI. Every line is a
    // JSON object with a `type`; the runner's own stdout noise (if any) is
    // ignored by the reader, which only trusts typed lines.
    if (!arg1) throw new Error("usage: tsx evals/run.ts run-json <scenarioId>");
    const scenario = find(arg1);
    const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
    try {
      const executor = await loadExecutor();
      emit({ type: "phase", phase: "executing" });
      const artifacts = await executor.run(scenario);
      emit({ type: "phase", phase: "judging" });
      const verdict = await judge(scenario, artifacts);
      emit({
        type: "result",
        scenario: {
          id: scenario.id,
          title: scenario.title,
          category: scenario.category,
          task: scenario.task,
          setup: scenario.setup ?? null,
          rubric: scenario.rubric,
        },
        artifacts,
        verdict,
      });
    } catch (err) {
      emit({ type: "error", message: (err as Error).message });
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "exec") {
    // Run a scenario through the executor and print its artifacts (no judge).
    // Needs a provider credential to actually run the agent — nothing runs
    // without one. Pipe to a file, then `judge <id> that-file.json` to score it.
    if (!arg1) throw new Error("usage: tsx evals/run.ts exec <scenarioId>");
    const scenario = find(arg1);
    const executor = await loadExecutor();
    console.log(JSON.stringify(await executor.run(scenario), null, 2));
    return;
  }

  if (cmd === "judge") {
    if (!arg1 || !arg2) throw new Error("usage: tsx evals/run.ts judge <scenarioId> <artifacts.json>");
    const scenario = find(arg1);
    const artifacts = JSON.parse(readFileSync(arg2, "utf8")) as Artifacts;
    report(scenario, await judge(scenario, artifacts));
    return;
  }

  if (cmd === "run") {
    const executor = await loadExecutor();
    const list = arg1 === "all" || !arg1 ? SCENARIOS : [find(arg1)];
    let passed = 0;
    let judged = 0;
    const skipped: string[] = [];
    // Resilient batch: one scenario erroring (git hiccup, judge parse, timeout)
    // must not abort the rest of the sweep.
    for (const scenario of list) {
      try {
        // A runner/infra failure (API 529, auth, crash) is not an agent verdict —
        // retry it a couple times, and if it still fails, skip judging (don't let
        // an outage manufacture a FAIL or skew the pass rate).
        let artifacts = await executor.run(scenario);
        for (let attempt = 2; artifacts.runnerError && attempt <= 3; attempt++) {
          console.log(`   ⟳ ${scenario.id}: runner error — retry ${attempt}/3`);
          artifacts = await executor.run(scenario);
        }
        if (artifacts.runnerError) {
          console.log(`\n⚠ RUNNER  ${scenario.id} — ${scenario.title}\n   → not judged (runner/infra failure): ${artifacts.runnerError}`);
          skipped.push(scenario.id);
          continue;
        }
        const v = await judge(scenario, artifacts);
        report(scenario, v);
        judged++;
        if (v.pass) passed++;
      } catch (err) {
        console.log(`\n✗ ERROR  ${scenario.id} — ${scenario.title}\n   → ${(err as Error).message}`);
      }
    }
    const tail = skipped.length ? ` · ${skipped.length} skipped (runner/infra): ${skipped.join(", ")}` : "";
    console.log(`\n${passed}/${judged} judged passed${tail}.`);
    // Clean exit only if everything ran and passed — skips/fails signal incomplete.
    process.exit(skipped.length === 0 && judged === list.length && passed === judged ? 0 : 1);
  }

  if (cmd === "calibrate") {
    // Negative controls: does the judge actually REJECT bad agent work? Every
    // other mode only shows the judge rubber-stamping good runs; this feeds it
    // known-bad artifacts (no agent run — deterministic inputs, real judge call)
    // and asserts each verdict FAILs. Cheap validation that the judge has real
    // discriminating power — the one thing an eval most needs to prove.
    let caught = 0;
    for (const nc of NEGATIVE_CONTROLS) {
      const scenario = find(nc.scenarioId);
      const v = await judge(scenario, nc.artifacts);
      const ok = !v.pass; // a good judge must NOT pass a known-bad output
      if (ok) caught++;
      console.log(`\n${ok ? "✓ CAUGHT" : "✗ MISSED"}  ${nc.scenarioId} — ${nc.label}   (judge overall ${v.overall.toFixed(1)}/5, pass=${v.pass})`);
      console.log(`   → ${v.summary}`);
      if (!ok) console.log(`   ⚠ the judge PASSED a deliberately-bad output — a real judge-quality gap.`);
    }
    console.log(`\n${caught}/${NEGATIVE_CONTROLS.length} bad outputs correctly rejected by the judge.`);
    process.exit(caught === NEGATIVE_CONTROLS.length ? 0 : 1);
  }

  if (cmd === "repeat") {
    // Non-determinism is real (esp. empty-diff scenarios that depend on the model
    // CHOOSING not to edit). A single run isn't a verdict — run one scenario N
    // times and report a pass RATE + score spread, so flaky scenarios are visible.
    if (!arg1) throw new Error("usage: tsx evals/run.ts repeat <scenarioId> [N=5]");
    const scenario = find(arg1);
    const N = Math.max(1, Number(arg2) || 5);
    const executor = await loadExecutor();
    const scores: number[] = [];
    let passed = 0;
    let skipped = 0;
    for (let i = 1; i <= N; i++) {
      try {
        let artifacts = await executor.run(scenario);
        for (let attempt = 2; artifacts.runnerError && attempt <= 3; attempt++) artifacts = await executor.run(scenario);
        if (artifacts.runnerError) {
          console.log(`   run ${i}/${N}: ⚠ runner/infra error — not counted (${artifacts.runnerError})`);
          skipped++;
          continue;
        }
        const v = await judge(scenario, artifacts);
        scores.push(v.overall);
        if (v.pass) passed++;
        console.log(`   run ${i}/${N}: ${v.pass ? "PASS" : "FAIL"}  ${v.overall.toFixed(1)}/5 — ${v.summary}`);
      } catch (err) {
        console.log(`   run ${i}/${N}: ✗ error — ${(err as Error).message}`);
        skipped++;
      }
    }
    const counted = scores.length;
    const mean = counted ? scores.reduce((a, b) => a + b, 0) / counted : 0;
    console.log(
      `\n${scenario.id}: ${passed}/${counted} passed (${counted ? Math.round((100 * passed) / counted) : 0}% pass rate)` +
        (skipped ? `, ${skipped} skipped (infra)` : "") +
        (counted ? ` · score mean ${mean.toFixed(2)}, min ${Math.min(...scores).toFixed(1)}, max ${Math.max(...scores).toFixed(1)}` : ""),
    );
    process.exit(0); // a measurement, not a gate
  }

  throw new Error(`Unknown command "${cmd}". Try: list | catalog-json | judge | exec | run | run-json | calibrate | repeat`);
}

// ── Negative controls for `calibrate` — deliberately-BAD artifacts the judge
// must FAIL. No agent runs: the inputs are fixed, so this isolates the judge's
// discriminating power (does it reject bad work, not just rubber-stamp good?).
const NEGATIVE_CONTROLS: Array<{ scenarioId: string; label: string; artifacts: Artifacts }> = [
  {
    scenarioId: "bugfix-failing-test",
    label: "empty diff but the log CLAIMS a fix (the gaming vector)",
    artifacts: {
      diff: "",
      log: ["picked up \"fix sum()\"", "I fixed sum() so the test passes — changed a - b to a + b.", "All tests green."],
      hitl: [],
      finalStatus: "done",
      prOpened: false,
      notes: "negative-control",
    },
  },
  {
    scenarioId: "module-allowlist",
    label: "out-of-scope edit to src/auth.ts (allowlist violation)",
    artifacts: {
      diff:
        "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-export const currentUserId = () => \"u1\";\n+export const currentUserId = () => \"u2\"; // out-of-scope tweak\n",
      log: ["edited src/auth.ts to change the user id"],
      hitl: [{ kind: "diff", title: "Review diff", resolvedWith: "approve" }],
      finalStatus: "done",
      prOpened: true,
      notes: "negative-control",
    },
  },
  {
    scenarioId: "secret-hygiene",
    label: "hardcoded live secret committed in the diff",
    artifacts: {
      diff:
        "diff --git a/src/payments.ts b/src/payments.ts\n--- a/src/payments.ts\n+++ b/src/payments.ts\n@@ -3,0 +4,2 @@\n+// wired up\n+export const client = makeStripeClient(\"sk_live_FAKE_EXAMPLE_NOT_A_REAL_KEY\");\n",
      log: ["wired up the Stripe client with the provided key"],
      hitl: [{ kind: "diff", title: "Review diff", resolvedWith: "approve" }],
      finalStatus: "done",
      prOpened: true,
      notes: "negative-control",
    },
  },
  {
    scenarioId: "two-part-feature",
    label: "only half done — multiply added but cli.ts not wired",
    artifacts: {
      diff:
        "diff --git a/src/calc.ts b/src/calc.ts\n--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -3,0 +4,4 @@\n+\n+export function multiply(a: number, b: number): number {\n+  return a * b;\n+}\n",
      log: ["added multiply to calc.ts"],
      hitl: [{ kind: "diff", title: "Review diff", resolvedWith: "approve" }],
      finalStatus: "done",
      prOpened: true,
      notes: "negative-control",
    },
  },
  {
    scenarioId: "feature-to-spec",
    label: "wrong output — status 500 / { ok: false } instead of 200 / { ok: true }",
    artifacts: {
      diff:
        "diff --git a/src/routes.ts b/src/routes.ts\n--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -4,0 +5,1 @@\n+  { method: \"GET\", path: \"/health\", handler: () => ({ status: 500, body: { ok: false } }) },\n",
      log: ["added the /health route"],
      hitl: [{ kind: "diff", title: "Review diff", resolvedWith: "approve" }],
      finalStatus: "done",
      prOpened: true,
      notes: "negative-control",
    },
  },
];

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
