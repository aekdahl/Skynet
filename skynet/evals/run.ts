// ─── LLM-judged acceptance runner (CLI) ────────────────────────────────────
//   tsx evals/run.ts list
//   tsx evals/run.ts judge <scenarioId> <artifacts.json>   (works today, needs a key)
//   tsx evals/run.ts run   <scenarioId|all>                (needs an Executor — see README)

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

  if (cmd === "exec") {
    // Run a scenario through the executor and print its artifacts (no judge —
    // works without a key; smoke-test with RUNNER=mock). Pipe to a file, then
    // `judge <id> that-file.json` to score it.
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

  throw new Error(`Unknown command "${cmd}". Try: list | judge | run`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
