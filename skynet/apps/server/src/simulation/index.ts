// ─── Simulation behavioral-judge HTTP surface ──────────────────────────────
// One route: POST /api/simulation/judge — the web hands over a journey's
// evidence (goal + steps + resulting board slice) and gets back an LLM verdict.
// Runs in-process (unlike the evals executor, which needs its own config-at-
// import subprocess): the judge only calls oneShotText, which the server can do
// directly. Gated on a Claude credential being present.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { judgeJourney, type JourneyEvidence } from "./judge.js";

function isEvidence(b: unknown): b is JourneyEvidence {
  const e = b as Partial<JourneyEvidence> | null;
  return !!e && typeof e.id === "string" && typeof e.goal === "string" && Array.isArray(e.steps);
}

export function registerSimulationRoutes(app: FastifyInstance): void {
  // The /api auth hook (registered by registerApi) already covers this route.
  app.post("/api/simulation/judge", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: "Judge unavailable — set a Claude credential (ANTHROPIC_API_KEY) to enable LLM review." });
    }
    if (!isEvidence(req.body)) {
      return reply.code(400).send({ error: "Bad evidence — expected { id, name, goal, steps[], board }." });
    }
    try {
      return await judgeJourney(req.body);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
}
