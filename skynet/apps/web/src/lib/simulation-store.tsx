// Simulation-run state, lifted to the app root so it survives view switches
// (the Simulation view is conditionally mounted). Mirrors AcceptanceProvider but
// simpler: journeys are client-driven only (no server LLM jobs). Also owns the
// "clear simulation data" sweep so the button works from a pure-reader view.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { JOURNEYS, clearSimulationData, type Step } from "./simulation";

export type SimStatus = "idle" | "running" | "pass" | "fail" | "skip";

function verdict(steps: Step[]): SimStatus {
  if (steps.some((s) => !s.ok && !s.skip)) return "fail";
  if (steps.some((s) => s.skip)) return "skip";
  return "pass";
}

export interface SimulationState {
  status: Record<string, SimStatus>;
  results: Record<string, Step[]>;
  running: boolean;
  clearing: boolean;
  lastClear: string | null;
  runOne: (id: string) => Promise<void>;
  runAll: () => Promise<void>;
  clearData: () => Promise<void>;
}

const Ctx = createContext<SimulationState | null>(null);

export function SimulationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Record<string, SimStatus>>({});
  const [results, setResults] = useState<Record<string, Step[]>>({});
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lastClear, setLastClear] = useState<string | null>(null);

  const runOne = useCallback(async (id: string) => {
    const journey = JOURNEYS.find((j) => j.id === id);
    if (!journey) return;
    setStatus((m) => ({ ...m, [id]: "running" }));
    try {
      const steps = await journey.run();
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

  const value: SimulationState = { status, results, running, clearing, lastClear, runOne, runAll, clearData };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSimulation(): SimulationState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSimulation must be used within SimulationProvider");
  return ctx;
}
