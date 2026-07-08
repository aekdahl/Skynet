// Acceptance-run state, lifted OUT of the view so it survives navigation.
//
// The Acceptance view is conditionally mounted (view === "acceptance"), so any
// run state held in the component died the moment you switched views — even with
// checks still running (control-plane runs kept going into a dead component; the
// server-side LLM jobs kept running but the UI forgot their ids and stopped
// polling). This provider owns that state and the run/poll loops and is mounted
// at the app root, so progress + history persist across view changes and the
// view is a pure reader.
//
// Note: control-plane results are in-tab (client-driven) so a full page RELOAD
// still clears them; LLM jobs live on the server (survive reload) but rediscovery
// after a reload needs a "list jobs" endpoint — tracked as a follow-up.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SCENARIOS, type Step } from "./acceptance";
import { fetchEvals, fetchEvalJob, runEval, type EvalJob, type EvalScenarioMeta } from "./client";

export type CpStatus = "idle" | "running" | "pass" | "fail" | "skip";

function verdict(steps: Step[]): CpStatus {
  if (steps.some((s) => !s.ok && !s.skip)) return "fail";
  if (steps.some((s) => s.skip)) return "skip";
  return "pass";
}

const isTerminal = (job?: EvalJob) => job?.phase === "done" || job?.phase === "error";

export interface AcceptanceState {
  // ── control-plane checks (client-driven) ────────────────────────────────
  cpStatus: Record<string, CpStatus>;
  cpResults: Record<string, Step[]>;
  cpRunning: boolean;
  runCpOne: (id: string) => Promise<void>;
  runCpAll: () => Promise<void>;
  // ── LLM-judged suite (server jobs) ──────────────────────────────────────
  evalScenarios: EvalScenarioMeta[] | null;
  evalKeyPresent: boolean;
  evalAvailable: boolean;
  evalLoadErr: string | null;
  jobs: Record<string, EvalJob>; // by scenarioId
  evalRunning: boolean;
  artifactsOpen: Record<string, boolean>;
  runEvalOne: (id: string) => Promise<void>;
  runEvalAll: () => Promise<void>;
  toggleArtifacts: (id: string) => void;
}

const Ctx = createContext<AcceptanceState | null>(null);

export function AcceptanceProvider({ children }: { children: ReactNode }) {
  // control-plane
  const [cpStatus, setCpStatus] = useState<Record<string, CpStatus>>({});
  const [cpResults, setCpResults] = useState<Record<string, Step[]>>({});
  const [cpRunning, setCpRunning] = useState(false);

  // llm-judged
  const [evalScenarios, setEvalScenarios] = useState<EvalScenarioMeta[] | null>(null);
  const [evalKeyPresent, setEvalKeyPresent] = useState(false);
  const [evalAvailable, setEvalAvailable] = useState(true);
  const [evalLoadErr, setEvalLoadErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, EvalJob>>({});
  const [evalRunning, setEvalRunning] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState<Record<string, boolean>>({});

  // Load the LLM scenario catalog once (the provider never unmounts).
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    fetchEvals()
      .then((r) => {
        setEvalScenarios(r.scenarios);
        setEvalKeyPresent(r.keyPresent);
        setEvalAvailable(r.available);
        if (r.error) setEvalLoadErr(r.error);
      })
      .catch((e) => setEvalLoadErr((e as Error).message));
  }, []);

  // ── control-plane runs ────────────────────────────────────────────────────
  const runCpOne = useCallback(async (id: string) => {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (!scenario) return;
    setCpStatus((m) => ({ ...m, [id]: "running" }));
    try {
      const steps = await scenario.run();
      setCpResults((m) => ({ ...m, [id]: steps }));
      setCpStatus((m) => ({ ...m, [id]: verdict(steps) }));
    } catch (e) {
      setCpResults((m) => ({ ...m, [id]: [{ label: "threw", ok: false, detail: (e as Error).message }] }));
      setCpStatus((m) => ({ ...m, [id]: "fail" }));
    }
  }, []);

  const runCpAll = useCallback(async () => {
    setCpRunning(true);
    try {
      for (const s of SCENARIOS) await runCpOne(s.id); // sequential — watch each land
    } finally {
      setCpRunning(false);
    }
  }, [runCpOne]);

  // ── LLM-judged runs (server jobs; poll to a terminal phase) ─────────────────
  // The poll loop lives here, so it keeps running while the operator is on
  // another view — no `mounted` guard, because the provider is always mounted.
  const runEvalOne = useCallback(
    (id: string): Promise<void> =>
      new Promise((resolve) => {
        setArtifactsOpen((m) => ({ ...m, [id]: false }));
        setJobs((m) => ({ ...m, [id]: { id: "", scenarioId: id, phase: "queued", logs: [], startedAt: Date.now() } }));
        runEval(id)
          .then(({ jobId }) => {
            const tick = async () => {
              try {
                const job = await fetchEvalJob(jobId);
                setJobs((m) => ({ ...m, [id]: job }));
                if (isTerminal(job)) return resolve();
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
      }),
    [],
  );

  const runEvalAll = useCallback(async () => {
    setEvalRunning(true);
    try {
      const list = evalScenarios ?? [];
      for (const s of list) await runEvalOne(s.id);
    } finally {
      setEvalRunning(false);
    }
  }, [evalScenarios, runEvalOne]);

  const toggleArtifacts = useCallback((id: string) => {
    setArtifactsOpen((m) => ({ ...m, [id]: !m[id] }));
  }, []);

  const value: AcceptanceState = {
    cpStatus, cpResults, cpRunning, runCpOne, runCpAll,
    evalScenarios, evalKeyPresent, evalAvailable, evalLoadErr,
    jobs, evalRunning, artifactsOpen, runEvalOne, runEvalAll, toggleArtifacts,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAcceptance(): AcceptanceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAcceptance must be used within AcceptanceProvider");
  return ctx;
}
