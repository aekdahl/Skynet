import { type Step } from "../lib/acceptance";
import { useAcceptance } from "../lib/acceptance-store";
import { useConfirm } from "../components/confirm";
import { SCENARIOS } from "../lib/acceptance";
import { type EvalJob } from "../lib/client";

// In-app acceptance runner. Run state lives in AcceptanceProvider (app root), so
// progress + results persist across view switches while checks/jobs keep running.
export function AcceptanceView() {
  const { cpStatus, cpResults, cpRunning, runCpOne, runCpAll } = useAcceptance();

  const passed = SCENARIOS.filter((s) => cpStatus[s.id] === "pass").length;
  const failed = SCENARIOS.filter((s) => cpStatus[s.id] === "fail").length;
  const skippedN = SCENARIOS.filter((s) => cpStatus[s.id] === "skip").length;

  return (
    <section className="vw acceptance">
      <div className="vw-head">
        <h1>Acceptance checks</h1>
        <p>
          Two suites: fast <strong>control-plane checks</strong> that drive the real API in-app, and
          the <strong>LLM-judged</strong> behavioral suite that runs a real agent per scenario and
          scores it with a judge model. Runs keep going while you work elsewhere in the app.
        </p>
      </div>

      <h2 className="acc-section-title">Control-plane checks</h2>
      <p className="acc-section-sub">
        Deterministic — no provider keys needed. Each drives the real API and asserts on the result;
        temporary “UAT:” projects clean themselves up.
      </p>

      <div className="acc-bar">
        <button className="btn btn-primary" disabled={cpRunning} onClick={() => void runCpAll()}>
          {cpRunning ? "Running…" : "Run all"}
        </button>
        <span className="acc-tally">
          {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
          {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
          {skippedN > 0 && <span className="acc-tally-skip">— {skippedN} skipped</span>}
        </span>
      </div>

      <div className="acc-list">
        {SCENARIOS.map((sc) => {
          const st = cpStatus[sc.id] ?? "idle";
          const steps = cpResults[sc.id];
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
                <button className="btn btn-ghost" disabled={st === "running" || cpRunning} onClick={() => void runCpOne(sc.id)}>
                  Run
                </button>
              </div>
              {steps && steps.length > 0 && <StepList steps={steps} />}
            </div>
          );
        })}
      </div>

      <LlmEvalSection />
    </section>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="acc-steps">
      {steps.map((s, i) => (
        <li key={i} className={s.ok ? "acc-step-ok" : s.skip ? "acc-step-skip" : "acc-step-bad"}>
          <span className="acc-step-mark">{s.ok ? "✓" : s.skip ? "—" : "✗"}</span>
          <span className="acc-step-label">{s.label}</span>
          {s.detail && <span className="acc-step-detail mono">{s.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

// ─── LLM-judged behavioral suite ───────────────────────────────────────────
// Real runs: each scenario provisions a live agent against a throwaway repo,
// then an LLM judge scores it against a rubric. The server runs the standalone
// evals/ suite as a subprocess; the provider starts a job and polls it (polling
// continues across view switches because it lives in the app-root provider).

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
  const {
    evalScenarios: scenarios,
    evalKeyPresent: keyPresent,
    evalAvailable: available,
    evalLoadErr: loadErr,
    jobs,
    evalRunning: running,
    artifactsOpen,
    runEvalOne,
    runEvalAll,
    toggleArtifacts,
  } = useAcceptance();
  const confirm = useConfirm();

  const onRunAll = async () => {
    if (!scenarios) return;
    const n = scenarios.length;
    const ok = await confirm({
      title: `Run all ${n} LLM-judged scenarios?`,
      body: (
        <>
          Each one provisions a <strong>real</strong> agent and then an LLM judge — roughly 1–3 minutes and
          real API tokens per scenario ({n} runs total). They run one at a time; you can watch each verdict land.
        </>
      ),
      confirmLabel: "Run all",
    });
    if (ok) void runEvalAll();
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
          <button className="btn btn-primary" disabled={disabled || !scenarios} onClick={onRunAll}>
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
          const showArtifacts = artifactsOpen[sc.id] && artifacts;
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
                  onClick={() => void runEvalOne(sc.id)}
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
                      onClick={() => toggleArtifacts(sc.id)}
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
