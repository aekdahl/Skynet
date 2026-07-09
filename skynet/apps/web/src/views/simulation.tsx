import { JOURNEYS, type Step } from "../lib/simulation";
import { useSimulation } from "../lib/simulation-store";

// Persistent, human-simulating regression runner. Unlike Acceptance (which
// cleans up after itself), each journey drives the core operator processes and
// LEAVES the state on the board — so a run doubles as a regression signal and a
// way to populate the starts-empty system. Run state lives in SimulationProvider
// (app root), so it persists across view switches. Reuses the acc-* styles.
export function SimulationView() {
  const { status, results, running, clearing, lastClear, runOne, runAll, clearData } = useSimulation();

  const passed = JOURNEYS.filter((j) => status[j.id] === "pass").length;
  const failed = JOURNEYS.filter((j) => status[j.id] === "fail").length;
  const skippedN = JOURNEYS.filter((j) => status[j.id] === "skip").length;

  const onClear = () => {
    if (window.confirm("Delete all simulation data? This removes every 'Sim:' project (and its agents) and idle 'sim-' runners.")) {
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
        </p>
      </div>

      <div className="acc-bar">
        <button className="btn btn-primary" disabled={running} onClick={() => void runAll()}>
          {running ? "Running…" : "Run all journeys"}
        </button>
        <span className="acc-tally">
          {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
          {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
          {skippedN > 0 && <span className="acc-tally-skip">— {skippedN} skipped</span>}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px" }}>
          {lastClear && <span className="acc-section-sub" style={{ margin: 0 }}>{lastClear}</span>}
          <button className="btn btn-ghost" disabled={clearing || running} onClick={onClear} title="Remove Sim: projects + sim- runners">
            {clearing ? "Clearing…" : "Clear simulation data"}
          </button>
        </span>
      </div>

      <p className="acc-section-sub">
        Best run with <code>RUNNER=mock</code> so assigned agents actually execute (no provider keys needed).
        Everything created is tagged <code>Sim:</code> / <code>sim-</code> and stays until you clear it.
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
                <button className="btn btn-ghost" disabled={st === "running" || running} onClick={() => void runOne(j.id)}>
                  Run
                </button>
              </div>
              {steps && steps.length > 0 && <StepList steps={steps} />}
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
