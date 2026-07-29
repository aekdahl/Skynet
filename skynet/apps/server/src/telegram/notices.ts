// ─── Telegram notification copy ─────────────────────────────────────────────
// The message BODIES the bridge pushes to the owner, kept pure (given already-
// resolved human names) so they're unit-testable. The point: lead with a run's
// task title + its project, never the raw ids that made these unreadable
// ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run pin-the-node-
// docker-image-to-a-d-1 needs attention").

import type { HitlItem } from "@skynet/shared";

export type Names = { run: string; project: string };

const GATE_HEAD: Partial<Record<HitlItem["kind"], string>> = {
  diff: "Review the changes",
  merge: "A merge needs a look",
  approval: "Approve a command",
  question: "A question for you",
  plan: "Review the plan",
  escalation: "A run stopped and needs help",
};

/** The gate heads-up body. `control` toggles the tappable-buttons hint vs the
 *  slash-command fallback. Never includes the internal gate/run id in the prose. */
export function gateNotice(it: HitlItem, names: Names, control: boolean): string {
  const head = GATE_HEAD[it.kind] ?? "Needs your review";
  const lines = [`🔔 ${head}${names.project ? ` · ${names.project}` : ""}`, names.run];
  if (it.kind === "diff" && it.diff) lines.push(`+${it.diff.add} −${it.diff.del} · ${it.risk} risk`);
  else if (it.command) lines.push(it.command);
  else if (it.kind === "question" && it.options?.length) lines.push(it.options.map((o, i) => `${i + 1}. ${o}`).join("\n"));
  else if (it.title) lines.push(it.title);
  lines.push(control ? "Approve or reject below 👇" : `Reply /approve ${it.id} or /reject ${it.id}`);
  return lines.join("\n");
}

/** A run parked in review with nothing tappable (no gate covers it). */
export function reviewNotice(names: Names): string {
  return [
    `⚠️ Needs a look${names.project ? ` · ${names.project}` : ""}`,
    names.run,
    "Paused for review — open it in the app to decide.",
  ].join("\n");
}

/** A run finished and integrated. */
export function completedNotice(names: Names): string {
  return `✅ Shipped${names.project ? ` · ${names.project}` : ""}\n${names.run}`;
}
