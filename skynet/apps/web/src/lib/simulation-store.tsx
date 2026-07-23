// Simulation-run state, lifted to the app root so it survives view switches
// (the Simulation view is conditionally mounted). Mirrors AcceptanceProvider but
// simpler: journeys are client-driven. On top of the deterministic run, an
// optional server-side LLM judge reviews each journey's evidence (goal + steps +
// resulting board) and returns a holistic behavioral verdict. Also owns the
// "clear simulation data" sweep so the button works from a pure-reader view.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { JOURNEYS, captureEvidence, clearSimulationData, drainWedgedRuns, type Step } from "./simulation";
import { fetchEvals, judgeSimulation, type SimVerdict } from "./client";
import * as api from "./client";

export type SimStatus = "idle" | "running" | "pass" | "fail" | "skip";

/** Per-journey LLM-judge state (the behavioral review, opt-in per run). */
export type JudgeState =
  | { phase: "judging" }
  | { phase: "done"; verdict: SimVerdict }
  | { phase: "error"; error: string };

function verdict(steps: Step[]): SimStatus {
  if (steps.some((s) => !s.ok && !s.skip)) return "fail";
  if (steps.some((s) => s.skip)) return "skip";
  return "pass";
}

export interface SimulationState {
  status: Record<string, SimStatus>;
  results: Record<string, Step[]>;
  verdicts: Record<string, JudgeState>;
  judgeAvailable: boolean;
  running: boolean;
  clearing: boolean;
  lastClear: string | null;
  runOne: (id: string) => Promise<void>;
  runAll: () => Promise<void>;
  judgeOne: (id: string) => Promise<void>;
  judgeAll: () => Promise<void>;
  clearData: () => Promise<void>;
}

const Ctx = createContext<SimulationState | null>(null);

export function SimulationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Record<string, SimStatus>>({});
  const [results, setResults] = useState<Record<string, Step[]>>({});
  const [verdicts, setVerdicts] = useState<Record<string, JudgeState>>({});
  const [judgeAvailable, setJudgeAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lastClear, setLastClear] = useState<string | null>(null);
  // Evidence captured at run time (the board right after the journey), used by
  // the judge later so its verdict reflects the state the journey produced.
  const evidence = useRef<Record<string, unknown>>({});

  // A behavioral judge needs a Claude credential; reuse the evals capability
  // probe (same credential) rather than a second endpoint.
  useEffect(() => {
    fetchEvals()
      .then((r) => setJudgeAvailable(!!r.keyPresent))
      .catch(() => setJudgeAvailable(false));
  }, []);

  const runOne = useCallback(async (id: string) => {
    const journey = JOURNEYS.find((j) => j.id === id);
    if (!journey) return;
    setStatus((m) => ({ ...m, [id]: "running" }));
    setVerdicts((m) => {
      const next = { ...m };
      delete next[id]; // a fresh run invalidates the old verdict
      return next;
    });
    try {
      // Which Sim projects AND fleet runners existed BEFORE — so we can
      // attribute the ones this journey creates and scope its evidence to just
      // those (isolated verdicts). Runners matter independently of runs: a
      // provisioning journey's goal can be an idle runner that executes nothing.
      const snapBefore = await api.fetchSnapshot().catch(() => null);
      const before = new Set(
        snapBefore?.projects.filter((p) => p.name.startsWith("Sim:")).map((p) => p.id) ?? [],
      );
      const fleetBefore = new Set(snapBefore?.fleet.map((r) => r.id) ?? []);
      const steps = await journey.run();
      // Drain any run this (or a prior) gate-journey left wedged on an unanswered
      // gate, so the board stays coherent and runners free up instead of piling up.
      await drainWedgedRuns().catch(() => undefined);
      const after = await api.fetchSnapshot().catch(() => null);
      const mine = after
        ? after.projects.filter((p) => p.name.startsWith("Sim:") && !before.has(p.id)).map((p) => p.id)
        : undefined;
      const mineRunners = after
        ? after.fleet.filter((r) => !fleetBefore.has(r.id)).map((r) => r.id)
        : undefined;
      evidence.current[id] = await captureEvidence(mine, mineRunners).catch(() => ({}));
      setResults((m) => ({ ...m, [id]: steps }));
      setStatus((m) => ({ ...m, [id]: verdict(steps) }));
    } catch (e) {
      setResults((m) => ({ ...m, [id]: [{ label: "threw", ok: false, detail: (e as Error).message }] }));
      setStatus((m) => ({ ...m, [id]: "fail" }));
    }
  }, []);

  const runAll = useCallback(async () => {
    setRunning(true);
    try {
      for (const j of JOURNEYS) await runOne(j.id); // sequential — each builds on real state
    } finally {
      setRunning(false);
    }
  }, [runOne]);

  const judgeOne = useCallback(
    async (id: string) => {
      const journey = JOURNEYS.find((j) => j.id === id);
      const steps = results[id];
      if (!journey || !steps) return;
      setVerdicts((m) => ({ ...m, [id]: { phase: "judging" } }));
      try {
        const v = await judgeSimulation({
          id: journey.id,
          name: journey.name,
          goal: journey.desc,
          steps: steps.map((s) => ({ label: s.label, ok: s.ok, skip: s.skip, detail: s.detail })),
          board: evidence.current[id] ?? {},
        });
        setVerdicts((m) => ({ ...m, [id]: { phase: "done", verdict: v } }));
      } catch (e) {
        const msg =
          e instanceof api.ApiError && e.status === 503
            ? "Judge unavailable — set a Claude credential (ANTHROPIC_API_KEY)."
            : (e as Error).message;
        setVerdicts((m) => ({ ...m, [id]: { phase: "error", error: msg } }));
      }
    },
    [results],
  );

  const judgeAll = useCallback(async () => {
    for (const j of JOURNEYS) if (results[j.id]) await judgeOne(j.id);
  }, [judgeOne, results]);

  const clearData = useCallback(async () => {
    setClearing(true);
    try {
      const { projects, runners } = await clearSimulationData();
      setLastClear(`removed ${projects} project(s) + ${runners} runner(s)`);
    } catch (e) {
      setLastClear(`clear failed: ${(e as Error).message}`);
    } finally {
      setClearing(false);
    }
  }, []);

  const value: SimulationState = {
    status,
    results,
    verdicts,
    judgeAvailable,
    running,
    clearing,
    lastClear,
    runOne,
    runAll,
    judgeOne,
    judgeAll,
    clearData,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSimulation(): SimulationState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSimulation must be used within SimulationProvider");
  return ctx;
}
