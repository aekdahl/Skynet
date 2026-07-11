// ─── LLM-judged acceptance evals — HTTP surface ────────────────────────────
// Surfaces the standalone `evals/` suite (the 20 behavioral, LLM-judged
// scenarios) inside the app's Acceptance view. These are REAL runs: each spawns
// a live agent against a throwaway repo, then an LLM judge scores it — minutes +
// API tokens per scenario.
//
// Why a subprocess, not an in-process import: the eval executor boots its OWN
// isolated stack against a throwaway git repo and captures config at import time
// (it sets SKYNET_INTEGRATION_REPO before importing the orchestrator). This
// server has ALREADY imported config, so importing the executor here would bind
// eval agents to the operator's real workspace. The harness lives outside the
// workspace on purpose and must run as its own process — so we spawn the same
// `tsx evals/run.ts` CLI the suite ships, inheriting this process's env (the
// .env-loaded ANTHROPIC_API_KEY the judge + runner need flows straight through).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const here = dirname(fileURLToPath(import.meta.url));
// apps/server/src/evals → repo root (skynet/) is four levels up.
const repoRoot = join(here, "..", "..", "..", "..");
const runScript = join(repoRoot, "evals", "run.ts");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

type Phase = "queued" | "executing" | "judging" | "done" | "error";

interface EvalJob {
  id: string;
  scenarioId: string;
  phase: Phase;
  logs: string[];
  result?: { scenario: unknown; artifacts: unknown; verdict: unknown };
  error?: string;
  startedAt: number;
  endedAt?: number;
}

const MAX_LOG_LINES = 500;
const jobs = new Map<string, EvalJob>();
let jobSeq = 0;

// The scenario catalog rarely changes within a process; the suite is standalone,
// so read it once via the CLI and memoize.
let catalogCache: unknown[] | null = null;

function spawnEval(args: string[]) {
  // env inherited from the server (which loaded skynet/.env at boot, so the child
  // sees ANTHROPIC_API_KEY etc.). The eval suite is real-runs-only; agents run on
  // their fleet runner's own provider (there is no mock).
  return spawn(tsxBin, [runScript, ...args], { cwd: repoRoot, env: { ...process.env } });
}

// True when a real run is actually possible right now (a mock server env is
// scrubbed above, so all we need is the provider credential the judge + agent use).
function canRunReal(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function readCatalog(): Promise<unknown[]> {
  if (catalogCache) return Promise.resolve(catalogCache);
  return new Promise((resolve, reject) => {
    const p = spawnEval(["catalog-json"]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      // Tolerant: the child may emit incidental stdout; take the first line that
      // parses as a JSON array (the catalog is one array on one line).
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("[")) continue;
        try {
          const arr = JSON.parse(t) as unknown[];
          if (Array.isArray(arr)) {
            catalogCache = arr;
            return resolve(arr);
          }
        } catch {
          /* not the catalog line — keep scanning */
        }
      }
      reject(new Error(`catalog-json failed (exit ${code}): ${(err || out).slice(0, 400)}`));
    });
  });
}

function startJob(scenarioId: string): EvalJob {
  const id = `evaljob-${Date.now().toString(36)}-${++jobSeq}`;
  const job: EvalJob = { id, scenarioId, phase: "queued", logs: [], startedAt: Date.now() };
  jobs.set(id, job);

  const pushLog = (line: string) => {
    job.logs.push(line);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  };

  const child = spawnEval(["run-json", scenarioId]);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { type?: string; [k: string]: unknown } | null = null;
      try {
        msg = JSON.parse(line);
      } catch {
        pushLog(line); // non-JSON runner noise → keep as a log line
        continue;
      }
      if (!msg || typeof msg.type !== "string") {
        pushLog(line);
        continue;
      }
      if (msg.type === "phase") {
        job.phase = msg.phase === "judging" ? "judging" : "executing";
      } else if (msg.type === "result") {
        job.result = {
          scenario: msg.scenario,
          artifacts: msg.artifacts,
          verdict: msg.verdict,
        };
        job.phase = "done";
        job.endedAt = Date.now();
      } else if (msg.type === "error") {
        job.error = String(msg.message ?? "eval error");
        job.phase = "error";
        job.endedAt = Date.now();
      } else {
        pushLog(line);
      }
    }
  });
  child.stderr.on("data", (d) => {
    for (const l of d.toString().split("\n")) {
      const t = l.trim();
      if (t) pushLog(t);
    }
  });
  child.on("error", (e) => {
    job.error = e.message;
    job.phase = "error";
    job.endedAt = Date.now();
  });
  child.on("close", (code) => {
    if (job.phase !== "done" && job.phase !== "error") {
      job.error = job.error ?? `eval process exited (${code}) without a verdict`;
      job.phase = "error";
      job.endedAt = Date.now();
    }
  });

  return job;
}

export async function registerEvalsRoutes(app: FastifyInstance): Promise<void> {
  // The /api auth hook (registered by registerApi) already applies to these
  // routes — they sit under /api on the same app instance.
  const available = existsSync(runScript) && existsSync(tsxBin);

  // Catalog + whether a real run is even possible right now.
  app.get("/api/evals", async () => {
    const keyPresent = canRunReal();
    if (!available) return { scenarios: [], keyPresent, available: false };
    try {
      const scenarios = await readCatalog();
      return { scenarios, keyPresent, available: true };
    } catch (e) {
      return { scenarios: [], keyPresent, available: false, error: (e as Error).message };
    }
  });

  // Kick off one scenario; returns a job id to poll.
  app.post("/api/evals/:id/run", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!available) return reply.code(503).send({ error: "eval harness not available in this build" });
    const { id } = req.params as { id: string };
    let catalog: unknown[];
    try {
      catalog = await readCatalog();
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
    if (!catalog.some((s) => (s as { id?: string }).id === id)) {
      return reply.code(404).send({ error: `unknown scenario "${id}"` });
    }
    const job = startJob(id);
    return { jobId: job.id };
  });

  // Poll a job's phase, logs, and (when finished) its verdict + artifacts.
  app.get("/api/evals/jobs/:jobId", async (req: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = req.params as { jobId: string };
    const job = jobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "unknown job" });
    return job;
  });
}
