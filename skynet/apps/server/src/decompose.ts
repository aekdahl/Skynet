// ─── Brief decomposition (structured output) ────────────────────────────────
// S7: turn an APPROVED SolutionBrief into a Feature + an ordered, sized, linked
// batch of Tasks — one LLM call, structured output, same discipline as
// merge-brief.ts / review-verdict.ts / task-linter.ts: read a field, never
// classify free prose. Operations.decomposeBrief creates Feature+Tasks only
// after `parseDecomposition` returns a genuinely readable plan — an
// unparseable reply (or one with no usable feature name / no usable tasks)
// returns null, the caller retries the consult ONCE, and a second null 4xxs
// with nothing created. A malformed individual FIELD within an otherwise-good
// plan (a bad effort value, a dependsOnIndex out of range or pointing forward)
// is sanitized rather than failing the whole plan — same "drop the bad entry,
// keep the good ones" discipline merge-brief.ts's risks/mitigations use — the
// thing a null return protects against is a NAMELESS feature or an EMPTY task
// list, not a single stray index.

import { extractJsonObject } from "./review-verdict.js";
import type { SolutionBrief } from "@skynet/shared";

export const DECOMPOSE_SYSTEM =
  "You are a senior engineer turning an APPROVED design doc into an execution plan: one Feature and a batch " +
  "of concrete, right-sized tasks a coding-agent fleet can pick up. Ground every task in what the brief " +
  "actually says — never invent scope the brief doesn't name.";

export const DECOMPOSE_INSTRUCTION = [
  'Respond with ONLY a JSON object and nothing else: {"feature":{"name":"<short feature name>",' +
    '"description":"<1-3 sentence summary of the approach>"},"tasks":[{"text":"<short, concrete, ' +
    'single-purpose task title>","description":"<what to do and why, one short paragraph>",' +
    '"acceptanceCriteria":["<one short line per concrete, checkable criterion>"],' +
    '"effort":"small"|"medium"|"large","dependsOnIndex":[<0-based indices into this SAME tasks array — ' +
    "only tasks that must finish first>]}]}",
  "Break the brief into as many tasks as it genuinely needs — usually 2 to 8. Each task should be " +
    "independently completable and reviewable; don't create a task for something the brief doesn't actually " +
    "call for. Order the array so a task never depends on one that comes AFTER it — dependsOnIndex may only " +
    "reference EARLIER indices in the array, never its own index or a later one. acceptanceCriteria should be " +
    "concrete, checkable outcomes, not restatements of the task text — draw from the brief's own acceptance " +
    "criteria where one applies to this specific task.",
].join(" ");

function briefContext(brief: SolutionBrief): string {
  return [
    `Title: ${brief.title}`,
    `Problem: ${brief.problem}`,
    `Approach: ${brief.approach}`,
    brief.optionsConsidered.length
      ? `Options considered:\n${brief.optionsConsidered.map((o) => `- ${o.name}: ${o.verdict} — ${o.why}`).join("\n")}`
      : null,
    brief.risks.length ? `Risks:\n${brief.risks.map((r) => `- ${r}`).join("\n")}` : null,
    brief.acceptanceCriteria.length
      ? "Brief-level acceptance criteria (the whole plan is done when ALL of these hold — distribute them " +
        `across the right tasks, don't just copy the whole list onto every task):\n${brief.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : null,
    brief.openQuestions.length
      ? `Open questions (unresolved — don't silently answer these, just be aware of them):\n${brief.openQuestions.map((q) => `- ${q}`).join("\n")}`
      : null,
  ]
    .filter((l): l is string => !!l)
    .join("\n\n");
}

// oneShotText (the consult path used here — see Operations.decomposeBrief;
// there's no live run to ride ConsultSpec.system on) takes one bare prompt
// string, unlike provider.consult's system-framing param — so the framing is
// folded directly into the prompt rather than kept separate.
export function buildDecomposePrompt(brief: SolutionBrief): string {
  return `${DECOMPOSE_SYSTEM}\n\n${briefContext(brief)}\n\n${DECOMPOSE_INSTRUCTION}`;
}

export type DecomposedEffort = "small" | "medium" | "large" | null;

export interface DecomposedTask {
  text: string;
  description: string;
  acceptanceCriteria: string[];
  effort: DecomposedEffort;
  /** Already sanitized: in-range, strictly-earlier indices only (see module doc). */
  dependsOnIndex: number[];
}

export interface Decomposition {
  feature: { name: string; description: string };
  tasks: DecomposedTask[];
}

const EFFORTS = new Set(["small", "medium", "large"]);

function shortStrings(v: unknown, cap: number, len: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= cap) break;
    if (typeof x === "string" && x.trim()) out.push(x.trim().slice(0, len));
  }
  return out;
}

/**
 * Read the model's structured plan. Returns null when there's nothing worth
 * creating from it: unparseable JSON, no feature name, or zero usable tasks
 * (every task missing its `text`). Otherwise returns a plan with every field
 * sanitized to a safe shape — the caller can create records from it directly.
 */
export function parseDecomposition(reply: string): Decomposition | null {
  const obj = extractJsonObject(reply);
  if (!obj) return null;

  const f = obj.feature && typeof obj.feature === "object" ? (obj.feature as Record<string, unknown>) : null;
  const featureName = f && typeof f.name === "string" ? f.name.trim().slice(0, 200) : "";
  if (!featureName) return null;
  const featureDescription = f && typeof f.description === "string" ? f.description.trim().slice(0, 1000) : "";

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  const tasks: DecomposedTask[] = [];
  for (const rt of rawTasks) {
    if (!rt || typeof rt !== "object") continue;
    const r = rt as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 300) : "";
    if (!text) continue; // a title-less task is nothing to create
    const description = typeof r.description === "string" ? r.description.trim().slice(0, 4000) : "";
    const acceptanceCriteria = shortStrings(r.acceptanceCriteria, 20, 300);
    const effort = typeof r.effort === "string" && EFFORTS.has(r.effort) ? (r.effort as "small" | "medium" | "large") : null;
    // dependsOnIndex is sanitized once positions are final, below (it needs
    // every task's real final index, which dropped/reordered entries shift).
    const dependsOnIndexRaw = Array.isArray(r.dependsOnIndex) ? r.dependsOnIndex.filter((n): n is number => typeof n === "number") : [];
    tasks.push({ text, description, acceptanceCriteria, effort, dependsOnIndex: dependsOnIndexRaw });
  }
  if (!tasks.length) return null;

  // Sanitize dependsOnIndex against the FINAL tasks array (post-drop): only
  // in-range, strictly-earlier indices survive — a self/forward reference or
  // an out-of-range one is silently dropped rather than failing the plan (the
  // model's own dropped/malformed task may have shifted what "index 2" means;
  // a raw pass-through here could create a nonsensical or even self-referential
  // dependency instead of just a missing one).
  for (let i = 0; i < tasks.length; i++) {
    const seen = new Set<number>();
    tasks[i]!.dependsOnIndex = tasks[i]!.dependsOnIndex.filter((idx) => {
      if (idx < 0 || idx >= tasks.length || idx >= i || seen.has(idx)) return false;
      seen.add(idx);
      return true;
    });
  }

  return { feature: { name: featureName, description: featureDescription }, tasks };
}
