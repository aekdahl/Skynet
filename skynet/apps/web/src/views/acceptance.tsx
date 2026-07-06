import { useState } from "react";
import { SCENARIOS, type Step } from "../lib/acceptance";

type Status = "idle" | "running" | "pass" | "fail";

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
      setStatus((m) => ({ ...m, [id]: steps.every((s) => s.ok) ? "pass" : "fail" }));
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

  return (
    <section className="vw acceptance">
      <div className="vw-head">
        <h1>Acceptance checks</h1>
        <p>
          Each check drives the real API and asserts on the result — run one, or all together, and
          watch the board react. Control-plane checks (no provider keys needed); temporary “UAT:”
          projects clean themselves up.
        </p>
      </div>

      <div className="acc-bar">
        <button className="btn btn-primary" disabled={running} onClick={runAll}>
          {running ? "Running…" : "Run all"}
        </button>
        <span className="acc-tally">
          {passed > 0 && <span className="acc-tally-ok">✓ {passed} passed</span>}
          {failed > 0 && <span className="acc-tally-fail">✗ {failed} failed</span>}
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
                  {st === "pass" ? "PASS" : st === "fail" ? "FAIL" : st === "running" ? "…" : "—"}
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
                    <li key={i} className={s.ok ? "acc-step-ok" : "acc-step-bad"}>
                      <span className="acc-step-mark">{s.ok ? "✓" : "✗"}</span>
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
    </section>
  );
}
