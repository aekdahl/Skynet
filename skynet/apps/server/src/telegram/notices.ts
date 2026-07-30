// ─── Telegram notification copy ─────────────────────────────────────────────
// The message BODIES the bridge pushes to the owner, kept pure (given already-
// resolved human names) so they're unit-testable. The point: lead with a run's
// task title + its project, never the raw ids that made these unreadable
// ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run pin-the-node-
// docker-image-to-a-d-1 needs attention").

import type { HitlItem } from "@skynet/shared";
import type { InlineKeyboardMarkup } from "./client.js";

export type Names = { run: string; project: string };

/** Escape text for Telegram HTML parse_mode (only &, <, > matter). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

/**
 * The rich HTML "decision card" for a gate — the SOTA upgrade over the plain
 * gateNotice: a bold head, the run + project, a diff summary / command / options,
 * and the agent's OWN reasoning (rationale) when it gave one. Rendered with
 * Telegram HTML parse_mode; all dynamic text is escaped. `control` toggles the
 * tappable-buttons hint vs. the slash-command fallback line.
 */
export function decisionCardHtml(it: HitlItem, names: Names, control: boolean): string {
  const head = GATE_HEAD[it.kind] ?? "Needs your review";
  const lines: string[] = [];
  lines.push(`🔔 <b>${esc(head)}</b>${names.project ? ` · ${esc(names.project)}` : ""}`);
  lines.push(esc(names.run));
  if (it.kind === "diff" && it.diff) {
    lines.push(`<code>+${it.diff.add} −${it.diff.del}</code> · ${esc(it.risk)} risk`);
  } else if (it.command) {
    lines.push(`<code>${esc(it.command)}</code>`);
  } else if (it.kind === "question" && it.options?.length) {
    lines.push(it.options.map((o, i) => `${i + 1}. ${esc(o)}`).join("\n"));
  } else if (it.title) {
    lines.push(esc(it.title));
  }
  // The agent's own words for WHY — the thing the plain notice dropped.
  if (it.rationale) lines.push(`\n<i>“${esc(it.rationale.trim())}”</i>`);
  lines.push(control ? "Tap below — or reply to this message to send changes." : `Reply /approve ${it.id} or /reject ${it.id}`);
  return lines.join("\n");
}

/**
 * The inline keyboard for a gate. Approve + Request changes for every gate;
 * View diff only when there's a diff to show; Reject to refuse. The gate id
 * rides in each callback_data so a tap resolves exactly the gate it was on.
 * Pure so it's unit-testable (no client/network).
 */
export function gateKeyboard(it: HitlItem): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "✅ Approve", callback_data: `hitl:approve:${it.id}` },
      { text: "✏️ Request changes", callback_data: `hitl:modify:${it.id}` },
    ],
  ];
  if (it.kind === "diff" || it.kind === "merge") {
    rows.push([{ text: "🔍 View diff", callback_data: `hitl:diff:${it.id}` }]);
  }
  rows.push([{ text: "⛔ Reject", callback_data: `hitl:reject:${it.id}` }]);
  return { inline_keyboard: rows };
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
