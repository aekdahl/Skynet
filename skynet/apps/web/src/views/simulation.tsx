import { JOURNEYS, type Step } from "../lib/simulation";
import { useSimulation, type JudgeState } from "../lib/simulation-store";

// Persistent, human-simulating regression runner. Unlike Acceptance (which
// cleans up after itself), each journey drives the core operator processes and
// LEAVES the state on the board — so a run doubles as a regression signal and a
// way to populate the starts-empty system. Run state lives in SimulationProvider
// (app root), so it persists across view switches. Reuses the acc-* styles.
export function SimulationView() {
  const { status, results, verdicts, judgeAvailable, running, clearing, lastClear, runOne, runAll, judgeOne, judgeAll, clearData } =
    useSimulation();
  const anyResults = JOURNEYS.some((j) => results[j.id]);

  const passed = JOURNEYS.filter((j) => status[j.id] === "pass").length;
  const failed = JOURNEYS.filter((j) => status[j.id] === "fail").length;
  const skippedN = JOURNEYS.filter((j) => status[j.id] === "skip").length;

  const onClear = () => {
    if (window.confirm("Delete all simulation data? This removes every 'Sim:' project (and its runs) and idle 'sim-' agents.")) {
      void clearData();
    }
  };

  return (
    <section className="vw acceptance">
      <div className="vw-head">
        <h1>Simulation</h1>
        <p>
          A <strong>persistent</strong> regression suite that plays the core operator processes the way
          a human would — and, unlike Acceptance, <strong>leaves the state it creates on the board</strong>.
          Each journey drives the real API and asserts every step, so a run is both a regression check and
          a way to populate the (starts-empty) system with realistic data. Runs keep going while you work elsewhere.
          {judgeAvailable
            ? " After a run, ⚖ Judge asks an LLM to review the outcome holistically — did the journey achieve its goal and is the resulting state coherent?"
            : " (Set a Claude credential to unlock the ⚖ LLM judge, which reviews each journey's outcome.)"}
        </p>
      </div>

      <div className="acc-bar">
        <button className="btn btn-primary" disabled={running} onClick={() => void runAll()}>
          {running ? "Running…" : "Run all journeys"}
        </button>
        {judgeAvailable && (
          <button className="btn btn-ghost" disabled={running || !anyResults} onClick={() => void judgeAll()} title="Have an LLM review every journey that has a result">
            ⚖ Judge all
          </button>
        )}
        <span className="acc-tally">
          {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
          {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
          {skippedN > 0 && <span className="acc-tally-skip">— {skippedN} skipped</span>}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px" }}>
          {lastClear && <span className="acc-section-sub" style={{ margin: 0 }}>{lastClear}</span>}
          <button className="btn btn-ghost" disabled={clearing || running} onClick={onClear} title="Remove Sim: projects + sim- agents">
            {clearing ? "Clearing…" : "Clear simulation data"}
          </button>
        </span>
      </div>

      <p className="acc-section-sub">
        Runs <strong>real agents</strong> on your configured fleet providers — set a provider credential
        (e.g. <code>ANTHROPIC_API_KEY</code>) and add a runner. Do <strong>not</strong> use{" "}
        <code>RUNNER=mock</code>: the mock fabricates canned activity (including that stray "migrate staging"
        gate) and proves nothing. Everything created is tagged <code>Sim:</code> / <code>sim-</code> and
        stays until you clear it.
      </p>

      <div className="acc-list">
        {JOURNEYS.map((j) => {
          const st = status[j.id] ?? "idle";
          const steps = results[j.id];
          return (
            <div className={"acc-row acc-" + st} key={j.id}>
              <div className="acc-row-head">
                <span className={"acc-badge acc-badge-" + st}>
                  {st === "pass" ? "PASS" : st === "fail" ? "FAIL" : st === "skip" ? "SKIP" : st === "running" ? "…" : "—"}
                </span>
                <div className="acc-meta">
                  <div className="acc-name">{j.name}</div>
                  <div className="acc-desc">{j.desc}</div>
                </div>
                {judgeAvailable && steps && steps.length > 0 && (
                  <button
                    className="btn btn-ghost"
                    disabled={verdicts[j.id]?.phase === "judging" || running}
                    onClick={() => void judgeOne(j.id)}
                    title="Have an LLM review this journey's outcome"
                  >
                    {verdicts[j.id]?.phase === "judging" ? "Judging…" : "⚖ Judge"}
                  </button>
                )}
                <button className="btn btn-ghost" disabled={st === "running" || running} onClick={() => void runOne(j.id)}>
                  Run
                </button>
              </div>
              {steps && steps.length > 0 && <StepList steps={steps} />}
              {verdicts[j.id] && <JudgeVerdict state={verdicts[j.id]!} />}
            </div>
          );
        })}
      </div>
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

// The LLM behavioral verdict for a journey: a holistic pass/fail + score, a
// one-line summary, and concrete findings — the review the deterministic step
// asserts can't do (goal achieved? end state coherent?).
function JudgeVerdict({ state }: { state: JudgeState }) {
  if (state.phase === "judging") {
    return <div className="sim-judge sim-judge-pending">⚖ LLM judge reviewing the outcome…</div>;
  }
  if (state.phase === "error") {
    return <div className="sim-judge sim-judge-err">⚖ Judge error — {state.error}</div>;
  }
  const v = state.verdict;
  return (
    <div className={"sim-judge " + (v.pass ? "sim-judge-pass" : "sim-judge-fail")}>
      <div className="sim-judge-head">
        <span className="sim-judge-badge">{v.pass ? "JUDGE ✓" : "JUDGE ✗"}</span>
        <span className="sim-judge-score mono">{v.score.toFixed(1)}/5</span>
        <span className="sim-judge-summary">{v.summary}</span>
      </div>
      {v.findings.length > 0 && (
        <ul className="sim-judge-findings">
          {v.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
