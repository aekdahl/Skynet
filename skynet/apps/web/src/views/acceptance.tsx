import { useEffect, useRef, useState } from "react";
import { SCENARIOS, type Step } from "../lib/acceptance";
import {
  fetchEvals,
  fetchEvalJob,
  runEval,
  type EvalJob,
  type EvalScenarioMeta,
} from "../lib/client";

type Status = "idle" | "running" | "pass" | "fail" | "skip";

// A scenario fails only on a real failed step; steps flagged `skip` are
// unmet preconditions (inconclusive), so a skip-only run reads as SKIP not FAIL.
function verdict(steps: Step[]): Status {
  if (steps.some((s) => !s.ok && !s.skip)) return "fail";
  if (steps.some((s) => s.skip)) return "skip";
  return "pass";
}

// In-app acceptance runner. Each scenario drives the real API and asserts on the
// result; run them one at a time or all together and watch the board react.
export function AcceptanceView() {
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [results, setResults] = useState<Record<string, Step[]>>({});
  const [running, setRunning] = useState(false);

  const runOne = async (id: string) => {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (!scenario) return;
    setStatus((m) => ({ ...m, [id]: "running" }));
    try {
      const steps = await scenario.run();
      setResults((m) => ({ ...m, [id]: steps }));
      setStatus((m) => ({ ...m, [id]: verdict(steps) }));
    } catch (e) {
      setResults((m) => ({ ...m, [id]: [{ label: "threw", ok: false, detail: (e as Error).message }] }));
      setStatus((m) => ({ ...m, [id]: "fail" }));
    }
  };

  const runAll = async () => {
    setRunning(true);
    for (const s of SCENARIOS) await runOne(s.id); // sequential so you can watch each
    setRunning(false);
  };

  const passed = SCENARIOS.filter((s) => status[s.id] === "pass").length;
  const failed = SCENARIOS.filter((s) => status[s.id] === "fail").length;
  const skippedN = SCENARIOS.filter((s) => status[s.id] === "skip").length;

  return (
    <section className="vw acceptance">
      <div className="vw-head">
        <h1>Acceptance checks</h1>
        <p>
          Two suites: fast <strong>control-plane checks</strong> that drive the real API in-app, and
          the <strong>LLM-judged</strong> behavioral suite that runs a real agent per scenario and
          scores it with a judge model.
        </p>
      </div>

      <h2 className="acc-section-title">Control-plane checks</h2>
      <p className="acc-section-sub">
        Deterministic — no provider keys needed. Each drives the real API and asserts on the result;
        temporary “UAT:” projects clean themselves up.
      </p>

      <div className="acc-bar">
        <button className="btn btn-primary" disabled={running} onClick={runAll}>
          {running ? "Running…" : "Run all"}
        </button>
        <span className="acc-tally">
          {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
          {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
          {skippedN > 0 && <span className="acc-tally-skip">— {skippedN} skipped</span>}
        </span>
      </div>

      <div className="acc-list">
        {SCENARIOS.map((sc) => {
          const st = status[sc.id] ?? "idle";
          const steps = results[sc.id];
          return (
            <div className={"acc-row acc-" + st} key={sc.id}>
              <div className="acc-row-head">
                <span className={"acc-badge acc-badge-" + st}>
                  {st === "pass" ? "PASS" : st === "fail" ? "FAIL" : st === "skip" ? "SKIP" : st === "running" ? "…" : "—"}
                </span>
                <div className="acc-meta">
                  <div className="acc-name">{sc.name}</div>
                  <div className="acc-desc">{sc.desc}</div>
                </div>
                <button className="btn btn-ghost" disabled={st === "running" || running} onClick={() => runOne(sc.id)}>
                  Run
                </button>
              </div>
              {steps && steps.length > 0 && (
                <ul className="acc-steps">
                  {steps.map((s, i) => (
                    <li key={i} className={s.ok ? "acc-step-ok" : s.skip ? "acc-step-skip" : "acc-step-bad"}>
                      <span className="acc-step-mark">{s.ok ? "✓" : s.skip ? "—" : "✗"}</span>
                      <span className="acc-step-label">{s.label}</span>
                      {s.detail && <span className="acc-step-detail mono">{s.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <LlmEvalSection />
    </section>
  );
}

// ─── LLM-judged behavioral suite ───────────────────────────────────────────
// Real runs: each scenario provisions a live agent against a throwaway repo,
// then an LLM judge scores it against a rubric (minutes + API tokens each). The
// server runs the standalone evals/ suite as a subprocess; we start a job and
// poll it to completion.

type LlmStatus = "idle" | "running" | "pass" | "fail" | "error";

function jobStatus(job?: EvalJob): LlmStatus {
  if (!job) return "idle";
  if (job.phase === "error") return "error";
  if (job.phase === "done") return job.result?.verdict.pass ? "pass" : "fail";
  return "running";
}

const badgeText: Record<LlmStatus, string> = { idle: "—", running: "…", pass: "PASS", fail: "FAIL", error: "ERR" };

function phaseLabel(job?: EvalJob): string {
  switch (job?.phase) {
    case "queued":
      return "queued…";
    case "executing":
      return "running agent…";
    case "judging":
      return "judging…";
    default:
      return "running…";
  }
}

function LlmEvalSection() {
  const [scenarios, setScenarios] = useState<EvalScenarioMeta[] | null>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [available, setAvailable] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, EvalJob>>({}); // by scenarioId
  const [open, setOpen] = useState<Record<string, boolean>>({}); // artifacts expanded, by scenarioId
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    fetchEvals()
      .then((r) => {
        if (!mounted.current) return;
        setScenarios(r.scenarios);
        setKeyPresent(r.keyPresent);
        setAvailable(r.available);
        if (r.error) setLoadErr(r.error);
      })
      .catch((e) => mounted.current && setLoadErr((e as Error).message));
    return () => {
      mounted.current = false;
    };
  }, []);

  // Start a scenario and poll its job to a terminal phase. Resolves when done so
  // "Run all" can sequence one after another.
  const runOne = (id: string): Promise<void> =>
    new Promise((resolve) => {
      setOpen((m) => ({ ...m, [id]: false }));
      setJobs((m) => ({
        ...m,
        [id]: { id: "", scenarioId: id, phase: "queued", logs: [], startedAt: Date.now() },
      }));
      runEval(id)
        .then(({ jobId }) => {
          const tick = async () => {
            if (!mounted.current) return resolve();
            try {
              const job = await fetchEvalJob(jobId);
              setJobs((m) => ({ ...m, [id]: job }));
              if (job.phase === "done" || job.phase === "error") return resolve();
            } catch {
              /* transient — keep polling */
            }
            setTimeout(tick, 1800);
          };
          setTimeout(tick, 1200);
        })
        .catch((e) => {
          setJobs((m) => ({
            ...m,
            [id]: { id: "", scenarioId: id, phase: "error", logs: [], error: (e as Error).message, startedAt: Date.now() },
          }));
          resolve();
        });
    });

  const runAll = async () => {
    if (!scenarios) return;
    const n = scenarios.length;
    const ok = window.confirm(
      `Run all ${n} LLM-judged scenarios?\n\n` +
        `Each one provisions a REAL agent and then an LLM judge — roughly 1–3 minutes and real API ` +
        `tokens per scenario (${n} runs total). They run one at a time; you can watch each verdict land.`,
    );
    if (!ok) return;
    setRunning(true);
    for (const s of scenarios) await runOne(s.id);
    setRunning(false);
  };

  const passed = scenarios?.filter((s) => jobStatus(jobs[s.id]) === "pass").length ?? 0;
  const failed = scenarios?.filter((s) => jobStatus(jobs[s.id]) === "fail").length ?? 0;
  const errored = scenarios?.filter((s) => jobStatus(jobs[s.id]) === "error").length ?? 0;

  const disabled = !keyPresent || running;

  return (
    <div className="acc-llm">
      <h2 className="acc-section-title">
        LLM-judged acceptance <span className="acc-real">real runs</span>
      </h2>
      <p className="acc-section-sub">
        Each scenario runs a real agent against a throwaway repo, then a judge model scores the diff
        + behavior against a rubric. Minutes and API tokens per run.
      </p>

      {!available && (
        <div className="acc-llm-warn">
          The eval harness isn’t available from this server build.
          {loadErr ? ` (${loadErr})` : ""}
        </div>
      )}
      {available && !keyPresent && (
        <div className="acc-llm-warn">
          No <code>ANTHROPIC_API_KEY</code> on the server — set it in <code>skynet/.env</code> and
          restart to run these (the agent and the judge both need it).
        </div>
      )}

      {available && (
        <div className="acc-bar">
          <button className="btn btn-primary" disabled={disabled || !scenarios} onClick={runAll}>
            {running ? "Running…" : "Run all"}
          </button>
          <span className="acc-tally">
            {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
            {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
            {errored > 0 && <span className="acc-tally-skip">! {errored} errored</span>}
          </span>
        </div>
      )}

      <div className="acc-list">
        {!scenarios && available && <div className="acc-section-sub">Loading scenarios…</div>}
        {scenarios?.map((sc) => {
          const job = jobs[sc.id];
          const st = jobStatus(job);
          const isRunning = st === "running";
          const v = job?.result?.verdict;
          const artifacts = job?.result?.artifacts;
          const showArtifacts = open[sc.id] && artifacts;
          return (
            <div className={"acc-row acc-" + st} key={sc.id}>
              <div className="acc-row-head">
                <span className={"acc-badge acc-badge-" + st}>{badgeText[st]}</span>
                <div className="acc-meta">
                  <div className="acc-name">
                    {sc.title} <span className="acc-cat">{sc.category}</span>
                  </div>
                  <div className="acc-desc">{sc.task}</div>
                </div>
                <button
                  className="btn btn-ghost"
                  disabled={disabled || isRunning}
                  onClick={() => runOne(sc.id)}
                  title={!keyPresent ? "Set ANTHROPIC_API_KEY to run" : undefined}
                >
                  Run
                </button>
              </div>

              {isRunning && <div className="acc-llm-phase">{phaseLabel(job)}</div>}

              {st === "error" && job?.error && (
                <ul className="acc-steps">
                  <li className="acc-step-bad">
                    <span className="acc-step-mark">✗</span>
                    <span className="acc-step-label">run failed</span>
                    <span className="acc-step-detail mono">{job.error}</span>
                  </li>
                </ul>
              )}

              {v && (
                <div className="acc-verdict">
                  <div className="acc-verdict-head">
                    <span className={"acc-vscore acc-vscore-" + (v.pass ? "ok" : "bad")}>
                      {v.overall.toFixed(1)}/5
                    </span>
                    <span className="acc-verdict-summary">{v.summary}</span>
                  </div>
                  <ul className="acc-steps">
                    {v.dimensions.map((d, i) => (
                      <li key={i} className={d.pass ? "acc-step-ok" : "acc-step-bad"}>
                        <span className="acc-step-mark">{d.pass ? "✓" : "✗"}</span>
                        <span className="acc-step-label">
                          {d.dimension} <span className="mono">{d.score}/5</span>
                        </span>
                        <span className="acc-step-detail">{d.rationale}</span>
                      </li>
                    ))}
                  </ul>
                  {artifacts && (
                    <button
                      className="btn btn-ghost acc-artifacts-toggle"
                      onClick={() => setOpen((m) => ({ ...m, [sc.id]: !m[sc.id] }))}
                    >
                      {showArtifacts ? "Hide artifacts" : "Artifacts"}
                    </button>
                  )}
                </div>
              )}

              {showArtifacts && artifacts && (
                <div className="acc-artifacts">
                  <div className="acc-art-line mono">
                    status={artifacts.finalStatus ?? "?"}
                    {artifacts.wallMs != null && ` · ${(artifacts.wallMs / 1000).toFixed(0)}s`}
                    {artifacts.notes ? ` · ${artifacts.notes}` : ""}
                  </div>
                  {artifacts.hitl && artifacts.hitl.length > 0 && (
                    <ul className="acc-steps">
                      {artifacts.hitl.map((h, i) => (
                        <li key={i} className="acc-step-skip">
                          <span className="acc-step-mark">⊙</span>
                          <span className="acc-step-label">
                            HITL: {h.kind} — {h.title}
                          </span>
                          {h.resolvedWith && <span className="acc-step-detail mono">{h.resolvedWith}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="acc-art-label">git diff</div>
                  <pre className="acc-diff mono">{artifacts.diff?.trim() || "(no diff)"}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
