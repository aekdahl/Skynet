// ─── Telegram notification copy ─────────────────────────────────────────────
// The message BODIES the bridge pushes to the owner, kept pure (given already-
// resolved human names) so they're unit-testable. The point: lead with a run's
// task title + its project, never the raw ids that made these unreadable
// ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run pin-the-node-
// docker-image-to-a-d-1 needs attention").

import type { HitlItem } from "@skynet/shared";
import type { InlineKeyboardMarkup } from "./client.js";

export type Names = { run: string; project: string };

/** Deep link to a run's detail page. Mirrors the web hash route
 *  (apps/web/src/lib/routing.ts: `#/agent/<runId>`). Empty base → no link. */
export function runLink(baseUrl: string, runId: string): string | undefined {
  return baseUrl ? `${baseUrl}/#/agent/${runId}` : undefined;
}

/** Desktop-only counterpart to `runLink` — a `skynet://` OS-protocol link
 *  instead of `PUBLIC_URL#/...`. The desktop app registers `skynet` as its
 *  default protocol client (apps/desktop/main.cjs) and translates the same
 *  `agent/<runId>` shape straight back into the hash route on receipt
 *  (apps/desktop/deep-link.cjs), so it needs no base URL / token at all — the
 *  app is already running locally as the single operator, and the OS just
 *  routes the click to it. Unconditional (never returns undefined): unlike
 *  the hosted case, there's no "is a base URL configured?" question on
 *  desktop — the protocol is always the same. */
export function desktopRunLink(runId: string): string {
  return `skynet://agent/${runId}`;
}

/** Escape text for Telegram HTML parse_mode (only &, <, > matter). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// How many changed files to list before collapsing the rest into "+N more" —
// enough to judge the blast radius on a phone without a wall of paths.
const MAX_FILES_SHOWN = 8;

/** The changed-file list + touched areas for a diff/merge gate. `escFn` escapes
 *  dynamic text (identity for the plain fallback, HTML-escape for the card) and
 *  `codeFn` wraps each path (identity vs `<code>…</code>`). Empty file list in →
 *  no lines, so older / empty-diff gates render exactly as before. */
function fileLines(it: HitlItem, escFn: (s: string) => string, codeFn: (s: string) => string): string[] {
  if (it.kind !== "diff" && it.kind !== "merge") return [];
  const files = it.diff?.files ?? [];
  const out: string[] = [];
  for (const f of files.slice(0, MAX_FILES_SHOWN)) out.push(`• ${codeFn(f)}`);
  if (files.length > MAX_FILES_SHOWN) out.push(`• …and ${files.length - MAX_FILES_SHOWN} more`);
  const areas = it.diff?.modules ?? [];
  if (areas.length) out.push(`Areas: ${escFn(areas.join(" · "))}`);
  return out;
}

// A verifier gate's output can run to tens of KB (capped upstream by
// Orchestrator.VERIFIER_OUTPUT_CAP) — Telegram messages cap at 4096 chars
// total, so only the first few lines fit; "Open in the app" is the way to see
// the rest (also rides the audit trail in full).
const MAX_OUTPUT_LINES = 6;
function outputSnippet(it: HitlItem): string | null {
  if (!it.output) return null;
  const lines = it.output.split("\n").filter((l) => l.trim());
  const snippet = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  return lines.length > MAX_OUTPUT_LINES ? `${snippet}\n…` : snippet;
}

const GATE_HEAD: Partial<Record<HitlItem["kind"], string>> = {
  diff: "Review the changes",
  merge: "A merge needs a look",
  approval: "Approve a command",
  question: "A question for you",
  plan: "Review the plan",
  escalation: "A run stopped and needs help",
  verifier: "Checks failed",
};

/** The gate heads-up body. `control` toggles the tappable-buttons hint vs the
 *  slash-command fallback. Never includes the internal gate/run id in the prose. */
export function gateNotice(it: HitlItem, names: Names, control: boolean, link?: string): string {
  const head = GATE_HEAD[it.kind] ?? "Needs your review";
  const lines = [`🔔 ${head}${names.project ? ` · ${names.project}` : ""}`, names.run];
  if (it.kind === "diff" && it.diff) {
    const n = it.diff.files?.length ?? 0;
    lines.push(`+${it.diff.add} −${it.diff.del} · ${it.risk} risk${n ? ` · ${n} file${n === 1 ? "" : "s"}` : ""}`);
    lines.push(...fileLines(it, (s) => s, (s) => s));
  } else if (it.command) lines.push(it.command);
  else if (it.kind === "question" && it.options?.length) lines.push(it.options.map((o, i) => `${i + 1}. ${o}`).join("\n"));
  else if (outputSnippet(it)) lines.push(outputSnippet(it)!);
  else if (it.title) lines.push(it.title);
  lines.push(control ? "Approve or reject below 👇" : `Reply /approve ${it.id} or /reject ${it.id}`);
  if (link) lines.push(`Open in the app → ${link}`);
  return lines.join("\n");
}

/**
 * The rich HTML "decision card" for a gate — the SOTA upgrade over the plain
 * gateNotice: a bold head, the run + project, a diff summary / command / options,
 * and the agent's OWN reasoning (rationale) when it gave one. Rendered with
 * Telegram HTML parse_mode; all dynamic text is escaped. `control` toggles the
 * tappable-buttons hint vs. the slash-command fallback line.
 */
export function decisionCardHtml(it: HitlItem, names: Names, control: boolean, link?: string): string {
  const head = GATE_HEAD[it.kind] ?? "Needs your review";
  const lines: string[] = [];
  lines.push(`🔔 <b>${esc(head)}</b>${names.project ? ` · ${esc(names.project)}` : ""}`);
  lines.push(esc(names.run));
  if (it.kind === "diff" && it.diff) {
    const n = it.diff.files?.length ?? 0;
    lines.push(`<code>+${it.diff.add} −${it.diff.del}</code> · ${esc(it.risk)} risk${n ? ` · ${n} file${n === 1 ? "" : "s"}` : ""}`);
    lines.push(...fileLines(it, esc, (s) => `<code>${esc(s)}</code>`));
  } else if (it.command) {
    lines.push(`<code>${esc(it.command)}</code>`);
  } else if (it.kind === "question" && it.options?.length) {
    // A decision: show the question, then a numbered choice list (matches the
    // per-option buttons) so it's unmistakably a selection.
    if (it.title) lines.push(esc(it.title));
    lines.push("<b>Choose one:</b>");
    lines.push(it.options.map((o, i) => `${i + 1}. ${esc(o)}`).join("\n"));
  } else if (outputSnippet(it)) {
    lines.push(`<pre>${esc(outputSnippet(it)!)}</pre>`);
  } else if (it.title) {
    lines.push(esc(it.title));
  }
  // The agent's own words for WHY — the thing the plain notice dropped.
  if (it.rationale) lines.push(`\n<i>“${esc(it.rationale.trim())}”</i>`);
  const isChoice = it.kind === "question" && !!it.options?.length;
  lines.push(
    control
      ? isChoice
        ? "👆 Tap your choice below — or reply with a different answer."
        : "Tap below — or reply to this message to send changes."
      : isChoice
        ? `Open the app to choose, or reply /reject ${it.id}`
        : `Reply /approve ${it.id} or /reject ${it.id}`,
  );
  // A run deep link to open the full gate in the app (a href is safe — the URL
  // is server config + a safe run id, no user text). Telegram HTML supports <a>.
  if (link) lines.push(`<a href="${esc(link)}">Open in the app ↗</a>`);
  return lines.join("\n");
}

/**
 * The inline keyboard for a gate. Approve + Request changes for every gate;
 * View diff only when there's a diff to show; Reject to refuse. The gate id
 * rides in each callback_data so a tap resolves exactly the gate it was on.
 * Pure so it's unit-testable (no client/network).
 */
export function gateKeyboard(it: HitlItem): InlineKeyboardMarkup {
  // A decision (AskUserQuestion) is a SELECTION, not an approve/reject gate — give
  // it one tappable button PER option (numbered to match the message body) so it's
  // obviously "pick one". Free-text answer + refuse still available below.
  if (it.kind === "question" && it.options?.length) {
    const rows: InlineKeyboardMarkup["inline_keyboard"] = it.options.map((opt, i) => [
      { text: `${i + 1}. ${clipBtn(opt)}`, callback_data: `hitl:option:${i}:${it.id}` },
    ]);
    rows.push([
      { text: "✏️ Other answer", callback_data: `hitl:modify:${it.id}` },
      { text: "⛔ Reject", callback_data: `hitl:reject:${it.id}` },
    ]);
    return { inline_keyboard: rows };
  }
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "✅ Approve", callback_data: `hitl:approve:${it.id}` },
      { text: "✏️ Request changes", callback_data: `hitl:modify:${it.id}` },
    ],
  ];
  if (it.kind === "diff" || it.kind === "merge" || it.kind === "verifier") {
    rows.push([{ text: "🔍 View diff", callback_data: `hitl:diff:${it.id}` }]);
  }
  rows.push([{ text: "⛔ Reject", callback_data: `hitl:reject:${it.id}` }]);
  return { inline_keyboard: rows };
}

/** Keep an option's button label short — Telegram truncates long buttons anyway,
 *  and the full text is already in the message body. */
function clipBtn(s: string): string {
  const t = s.trim();
  return t.length > 40 ? t.slice(0, 39) + "…" : t;
}

/** A run parked in review with nothing tappable (no gate covers it). */
export function reviewNotice(names: Names, link?: string): string {
  return [
    `⚠️ Needs a look${names.project ? ` · ${names.project}` : ""}`,
    names.run,
    link
      ? `Paused for review — open it to decide → ${link}`
      : "Paused for review — open it in the app to decide.",
  ].join("\n");
}

/** A run finished and integrated. */
export function completedNotice(names: Names, link?: string): string {
  const head = `✅ Shipped${names.project ? ` · ${names.project}` : ""}\n${names.run}`;
  return link ? `${head}\nView → ${link}` : head;
}

/** HTML "done" state a live decision card is edited into once its run ships —
 *  so the card you decided on becomes the result, in place. */
export function shippedCardHtml(names: Names): string {
  return `✅ <b>Shipped</b>${names.project ? ` · ${esc(names.project)}` : ""}\n${esc(names.run)}`;
}

/**
 * The on-demand digest (/inbox) — one glanceable summary, decisions first. Pure:
 * the caller resolves names + counts. HTML; all dynamic text escaped. `gates`
 * are the open decisions, most-urgent first; `running`/`done` are run counts.
 */
export function digestText(d: {
  gates: { head: string; run: string }[];
  running: number;
  done: number;
}): string {
  const head = `◆ <b>${d.gates.length} waiting on you</b> · ${d.running} running · ${d.done} done`;
  if (d.gates.length === 0) {
    return `${head}\n\nNothing needs a decision right now.`;
  }
  const MAX = 6;
  const rows = d.gates.slice(0, MAX).map((g) => `🔔 ${esc(g.head)} — ${esc(g.run)}`);
  if (d.gates.length > MAX) rows.push(`…and ${d.gates.length - MAX} more`);
  return `${head}\n\n${rows.join("\n")}`;
}

/** The head phrase for a gate kind (shared by the card + the digest). */
export function gateHead(kind: HitlItem["kind"]): string {
  return GATE_HEAD[kind] ?? "Needs your review";
}

/**
 * Is `date`'s local hour inside a quiet-hours window? `range` is inclusive-start,
 * exclusive-end in whole hours (e.g. {start:22,end:7} = 22:00–06:59), wrapping
 * midnight when start > end. Used to hold low-value pings (ships) overnight —
 * decisions always go through regardless. `null` range = never quiet.
 */
export function inQuietHours(date: Date, range: { start: number; end: number } | null): boolean {
  if (!range) return false;
  const h = date.getHours();
  return range.start <= range.end ? h >= range.start && h < range.end : h >= range.start || h < range.end;
}

/** Parse "22-7" → {start:22,end:7}. Returns null for empty/invalid input. */
export function parseQuietHours(raw: string | undefined): { start: number; end: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > 23 || end > 23) return null;
  return { start, end };
}
