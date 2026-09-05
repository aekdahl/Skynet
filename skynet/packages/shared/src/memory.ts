// ─── Skynet Open Memory Format — wire contracts (Memory v0, phase 1) ────────
// The FILE format itself is docs/memory-format.md; apps/server/src/
// memory-format-reader.ts parses it into plain TS interfaces (MemoryFact/
// MemoryFile) for server-internal use. These are the WIRE shapes the API and
// web app share — flatter, one fact per row with its scope inlined, since the
// UI lists facts across scopes rather than walking a nested file tree.
//
// Phase 1 scope: operator-authored facts only (source is always "operator",
// confidence always "stated" — the server sets both, never the caller).
// "decision" (Resolution.memoryNote → hitl_audit capture) and "distilled"
// (LLM-derived) are real spec values a hand-edited file can already contain —
// this phase reads and displays them like any other fact — but nothing here
// writes them; that's phase 2 and v4 respectively.

import { z } from "zod";
import { Timestamp } from "./contracts.js";

export const MemoryFactSource = z.enum(["operator", "decision", "distilled"]);
export type MemoryFactSource = z.infer<typeof MemoryFactSource>;

export const MemoryConfidence = z.enum(["stated", "derived", "distilled"]);
export type MemoryConfidence = z.infer<typeof MemoryConfidence>;

// Matches docs/memory-format.md's frontmatter `scope` field. Despite the
// name, "workspace" here means "this project's own .skynet/memory/ tree as a
// whole" (mirroring .skynet/modules.json's existing per-project-repo
// placement) — NOT Skynet's own cross-project Workspace entity. A fact this
// broad still lives inside one project's repo; there is no multi-repo
// propagation in this phase.
export const MemoryScope = z.enum(["workspace", "project", "area", "agent"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryFactSummary = z.object({
  id: z.string(),
  scope: MemoryScope,
  // Set only when scope is "area" or "agent" respectively; null otherwise.
  area: z.string().nullable(),
  agentFamily: z.string().nullable(),
  heading: z.string(),
  body: z.string(),
  source: MemoryFactSource,
  confidence: MemoryConfidence,
  author: z.string(),
  createdAt: Timestamp,
  // Null unless a hand-edited file used a run/hitl id the server didn't mint —
  // phase 1 never writes these itself.
  run: z.string().nullable(),
  hitl: z.string().nullable(),
  supersedes: z.string().nullable(),
  // True when some OTHER fact's `supersedes` names this one — still returned
  // (the file keeps superseded facts as history, per the format's append-only
  // model) so the UI can render it struck through rather than hiding it.
  superseded: z.boolean(),
});
export type MemoryFactSummary = z.infer<typeof MemoryFactSummary>;

export const CreateMemoryFactRequest = z.object({
  scope: MemoryScope,
  // Required (and only meaningful) when scope is "area".
  area: z.string().trim().min(1).nullable().optional(),
  // Required (and only meaningful) when scope is "agent" — a provider id
  // ("claude", "codex", ...), matching Agent.provider.
  agentFamily: z.string().trim().min(1).nullable().optional(),
  heading: z.string().trim().min(1),
  body: z.string().default(""),
  // Corrects/retires an existing fact rather than editing it in place — see
  // the format's own "append, don't mutate" editing model.
  supersedes: z.string().nullable().optional(),
});
export type CreateMemoryFactRequest = z.infer<typeof CreateMemoryFactRequest>;
