// ─── Telegram notification copy ─────────────────────────────────────────────
// The message BODIES the bridge pushes to the owner, kept pure (given already-
// resolved human names) so they're unit-testable. The point: lead with a run's
// task title + its project, never the raw ids that made these unreadable
// ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run pin-the-node-
// docker-image-to-a-d-1 needs attention").

import type { HitlItem, Resolution } from "@skynet/shared";
import type { InlineKeyboardMarkup } from "./client.js";
import { rememberableRisk } from "../approval-policy.js";

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
  roadmap_edit: "A roadmap edit needs your yes",
};

// A `stuck-review` escalation (orchestrator.ts's reapStuckReviews) is the one
// `escalation` case where nothing actually broke — the run already finished
// and reached review, it just has no open gate pointing at it. It gets its
// own calm head instead of the generic "stopped and needs help" alarm.
function isStuckReview(it: HitlItem): boolean {
  return it.kind === "escalation" && (it.flags ?? []).includes("stuck-review");
}
function headFor(it: HitlItem): string {
  return isStuckReview(it) ? "Done — awaiting your review" : (GATE_HEAD[it.kind] ?? "Needs your review");
}

// ─── Decision-card bubble structure ─────────────────────────────────────────
// Telegram's Bot API has no way for a bot to set bubble/background colors —
// those are the RECEIVING CLIENT's own theme (dark/light, chosen by the
// operator), never something `parse_mode: "HTML"` can touch. The card below
// is re-skinned at the level Telegram actually gives a bot control over: the
// TEXT structure (a short all-caps kind label, a one-sentence verdict, a mono
// command inset, a risk-flagged consequence line, a plain-language context
// line) — Telegram's own dark theme paints the surrounding chrome and stamps
// every message with its own delivery timestamp bottom-right for free.

const KIND_LABEL: Record<HitlItem["kind"], string> = {
  approval: "APPROVAL NEEDED",
  diff: "REVIEW NEEDED",
  merge: "MERGE NEEDS YOU",
  question: "DECISION NEEDED",
  plan: "PLAN REVIEW",
  escalation: "NEEDS HELP",
  verifier: "CHECKS FAILED",
  roadmap_edit: "ROADMAP EDIT · NEEDS YOUR YES",
};

/** All-caps kind label for the card's header line — "AWAITING REVIEW" for a
 *  stuck-review escalation (nothing failed), the per-kind label otherwise. */
function kindLabel(it: HitlItem): string {
  return isStuckReview(it) ? "AWAITING REVIEW" : (KIND_LABEL[it.kind] ?? "NEEDS YOU");
}

/** A short, stable, glanceable run tag ("RUN #A912") — the last 4 alphanumeric
 *  characters of the run id, uppercased. Not an identifier the operator needs
 *  to type anywhere (buttons carry the real id); just something to visually
 *  anchor "which run is this" without the full ugly id. */
function shortRunTag(runId: string): string {
  const clean = runId.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(-4) || clean).toUpperCase();
}

/** A one-line, risk-flagged statement of what actually happens if this is
 *  approved — distinct from `why` (which explains the DECISION) and `title`
 *  (the verdict). Medium/high risk gets the ⚠️ flag (the closest a bot can
 *  get to "amber" — Telegram can't tint text); low risk reads as reassurance. */
function consequenceLine(it: HitlItem): string {
  if (it.risk === "high") return "⚠️ High risk — can affect things outside the sandbox (e.g. a push, deploy, or an irreversible change).";
  if (it.risk === "medium") return "⚠️ Medium risk — writes or changes state inside the project.";
  return "Low risk — reversible, contained to the project sandbox.";
}

/** The always-true reason the operator is being pinged: the run is genuinely
 *  blocked until this gate resolves — no auto-timeout silently moves on. */
const CONTEXT_LINE = "Agent is idle until you answer.";

/** `telegram:<ownerChatId>` (the only Telegram-originated operatorId, see
 *  index.ts) reads as "you" — there's no name directory to resolve it against
 *  (single-owner scope, unchanged by this task); any other operatorId is
 *  already a human-readable id (e.g. "jordan") and is shown as-is, matching
 *  how the web audit trail already renders it (audit.tsx). */
function humanizeOperator(operatorId: string): string {
  return operatorId.startsWith("telegram:") ? "you" : operatorId;
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The gate heads-up body. `control` toggles the tappable-buttons hint vs the
 *  slash-command fallback. Never includes the internal gate/run id in the prose.
 *  Mirrors the web queue card's own ordering (queue.tsx): title → why →
 *  kind-specific content → captured output → conflicting files. `why` — the
 *  system's own explanation of what's being asked and what the buttons do —
 *  used to be dropped entirely here; a merge/verifier gate then rendered as a
 *  raw captured-output dump with nothing explaining it, unreadable/unactionable
 *  on a phone (reported live against a merge-conflict card). */
export function gateNotice(it: HitlItem, names: Names, control: boolean, link?: string): string {
  const head = headFor(it);
  const lines = [`🔔 ${head}${names.project ? ` · ${names.project}` : ""}`, names.run];
  if (it.title) lines.push(it.title);
  if (it.why) lines.push(it.why);
  if (it.kind === "diff" && it.diff) {
    const n = it.diff.files?.length ?? 0;
    lines.push(`+${it.diff.add} −${it.diff.del} · ${it.risk} risk${n ? ` · ${n} file${n === 1 ? "" : "s"}` : ""}`);
    lines.push(...fileLines(it, (s) => s, (s) => s));
  } else if (it.command) lines.push(it.command);
  else if (it.kind === "question" && it.options?.length) lines.push(it.options.map((o, i) => `${i + 1}. ${o}`).join("\n"));
  if (outputSnippet(it)) {
    if (it.kind === "merge") lines.push("Conflict (captured before the merge was aborted) — Modify sends this to the agent as-is:");
    lines.push(outputSnippet(it)!);
  }
  if (it.kind === "merge" && it.flags?.length) lines.push(`Conflicts in: ${it.flags.join(", ")}`);
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
 *
 * Ordering mirrors the web queue card (queue.tsx): title → rationale → why →
 * kind-specific content → captured output → conflicting files. `why` — the
 * system's own explanation of what's being asked and what the buttons do —
 * used to be dropped entirely: a merge/verifier gate rendered as a raw
 * captured-output dump (a conflict diff or check log) with nothing telling the
 * operator what happened or what to do about it — reported live as literally
 * impossible to act on from a merge-conflict card.
 */
export function decisionCardHtml(it: HitlItem, names: Names, control: boolean, link?: string): string {
  if (it.kind === "roadmap_edit") return roadmapEditCardHtml(it, names, control, link);
  const lines: string[] = [];
  // Kind label + run tag — the header line the operator scans first.
  lines.push(`<b>${esc(kindLabel(it))}</b>${names.project ? ` · ${esc(names.project)}` : ""} · RUN #${esc(shortRunTag(it.runId))}`);
  lines.push(esc(names.run));
  // One-sentence verdict.
  if (it.title) lines.push(`<b>${esc(it.title)}</b>`);
  if (it.rationale) lines.push(`<i>“${esc(it.rationale.trim())}”</i>`);
  if (it.why) lines.push(esc(it.why));
  if (it.kind === "diff" && it.diff) {
    const n = it.diff.files?.length ?? 0;
    lines.push(`<code>+${it.diff.add} −${it.diff.del}</code> · ${esc(it.risk)} risk${n ? ` · ${n} file${n === 1 ? "" : "s"}` : ""}`);
    lines.push(...fileLines(it, esc, (s) => `<code>${esc(s)}</code>`));
  } else if (it.command) {
    // Mono command inset, immediately followed by its risk-flagged consequence.
    lines.push(`<code>${esc(it.command)}</code>`);
  } else if (it.kind === "question" && it.options?.length) {
    // A decision: show a numbered choice list (matches the per-option
    // buttons) so it's unmistakably a selection — the question itself is
    // already shown above as the title.
    lines.push("<b>Choose one:</b>");
    lines.push(it.options.map((o, i) => `${i + 1}. ${esc(o)}`).join("\n"));
  }
  lines.push(esc(consequenceLine(it)));
  if (outputSnippet(it)) {
    // A merge gate's captured output is the raw `<<<<<<<`/`=======`/`>>>>>>>`
    // conflict text — genuinely hard to read on a phone even labeled, but
    // `why` above already told the operator what it is and what to do; this
    // is supplementary detail, same as the web card's own labeled preview.
    if (it.kind === "merge") lines.push("<i>Conflict (captured before the merge was aborted) — Modify sends this to the agent as-is:</i>");
    lines.push(`<pre>${esc(outputSnippet(it)!)}</pre>`);
  }
  if (it.kind === "merge" && it.flags?.length) {
    lines.push(`<b>Conflicts in:</b> ${it.flags.map((f) => `<code>${esc(f)}</code>`).join(", ")}`);
  }
  // Context line — the run is genuinely blocked until this resolves.
  lines.push(esc(CONTEXT_LINE));
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
  // (Also rides as its own "Open the run in Skynet ↗" keyboard button — see
  // gateKeyboard — kept here too as a fallback when control/keyboards are off.)
  if (link) lines.push(`<a href="${esc(link)}">Open in the app ↗</a>`);
  return lines.join("\n");
}

/**
 * TASK 30 — a roadmap_edit gate's compressed Telegram card: headline + why +
 * actions, none of the rich diff/impact/boundaries anatomy the web Inbox
 * card renders (no live-fetch here — see HitlItem.roadmapProposalId's own
 * doc comment for why Telegram works off the static snapshot instead). A
 * proposal whose diff includes a deletion (`flags` carries "has_deletion",
 * set once at raise time — Operations.raiseRoadmapEditHitl) gets NO approve
 * action here at all, held_conflict included (Rule 4 can only fire on an
 * overlapping REMOVED line, so a conflict always carries a deletion too) —
 * "Open in Skynet" is the only way to actually decide one of those; a phone
 * notification is the wrong place to bless a roadmap deletion sight-unseen.
 */
function roadmapEditCardHtml(it: HitlItem, names: Names, control: boolean, link?: string): string {
  const blocked = it.flags.includes("has_deletion");
  const lines = [`<b>${esc(KIND_LABEL.roadmap_edit)}</b>${names.project ? ` · ${esc(names.project)}` : ""}`, esc(names.run)];
  if (it.title) lines.push(`<b>${esc(it.title)}</b>`);
  if (it.why) lines.push(esc(it.why));
  if (blocked) {
    lines.push("⚠️ Removes content (or a held conflict) — review the full diff in Skynet before deciding.");
  } else {
    lines.push(
      control
        ? "Tap below — or open Skynet for the full diff, impact, and what it didn't touch."
        : `Reply /approve ${it.id} or /reject ${it.id}, or open Skynet for the full diff.`,
    );
  }
  if (link) lines.push(`<a href="${esc(link)}">Open in Skynet ↗</a>`);
  return lines.join("\n");
}

/**
 * The inline keyboard for a gate. Pure so it's unit-testable (no client/
 * network). The gate id rides in each callback_data so a tap resolves exactly
 * the gate it was on; an `url` button (never callback_data) opens the run in
 * the app directly, no round trip through the bot.
 *
 * `approval` gates get the exact 3-row shape: Approve once / Reject, then
 * (only when the command is rememberable — the SAME live classification
 * `Operations.addApprovalRule`/the web "ALWAYS FOR THIS PROJECT" action use,
 * see approval-policy.ts's `rememberableRisk`) a full-width "Always allow for
 * <project>" row, then Open-in-Skynet. Every other kind keeps its existing
 * Approve/Request-changes(+View diff)/Reject shape — "always allow" has no
 * meaning for a diff, merge, or a free-form question.
 */
export function gateKeyboard(it: HitlItem, projectName = "", link?: string): InlineKeyboardMarkup {
  const openLinkRow: InlineKeyboardMarkup["inline_keyboard"] = link
    ? [[{ text: "Open the run in Skynet ↗", url: link }]]
    : [];

  // TASK 30 — roadmap_edit: no run, so no "View diff"/"Request changes"
  // machinery applies. A deletion (or held_conflict, which always carries
  // one — see roadmapEditCardHtml's own doc comment) gets ONLY the open-link
  // row, no approve action at all.
  if (it.kind === "roadmap_edit") {
    const openInSkynet: InlineKeyboardMarkup["inline_keyboard"] = link ? [[{ text: "Open in Skynet ↗", url: link }]] : [];
    if (it.flags.includes("has_deletion")) return { inline_keyboard: openInSkynet };
    return {
      inline_keyboard: [
        [
          { text: "✅ Approve & commit", callback_data: `hitl:approve:${it.id}` },
          { text: "⛔ Reject", callback_data: `hitl:reject:${it.id}` },
        ],
        ...openInSkynet,
      ],
    };
  }

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
    return { inline_keyboard: [...rows, ...openLinkRow] };
  }

  if (it.kind === "approval" && it.command) {
    const rows: InlineKeyboardMarkup["inline_keyboard"] = [
      [
        { text: "Approve once", callback_data: `hitl:approve:${it.id}` },
        { text: "⛔ Reject", callback_data: `hitl:reject:${it.id}` },
      ],
    ];
    if (rememberableRisk(it.command) != null) {
      rows.push([{ text: `Always allow for ${clipBtn(projectName || "this project")}`, callback_data: `hitl:remember:${it.id}` }]);
    }
    return { inline_keyboard: [...rows, ...openLinkRow] };
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
  return { inline_keyboard: [...rows, ...openLinkRow] };
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

const RESOLUTION_HEAD: Record<Resolution["action"], string> = {
  approve: "✅ Approved",
  reject: "🚫 Rejected",
  modify: "✏️ Changes requested",
  option: "✅ Answered",
  reassign: "↻ Reassigned",
  dismiss: "🗑 Dismissed",
  push: "🚀 Pushed",
};

/**
 * HTML "resolved" state a live decision card is edited into the moment its
 * gate is resolved — from EITHER channel (a Telegram button tap or the web
 * inbox; `hitl.resolved` fires the same either way, see index.ts's `handler`).
 * This is what closes the gap between "buttons get stripped" (always worked)
 * and "the card reads as decided, with who and when" (didn't). No name
 * directory exists for `by` (see `humanizeOperator`) — a Telegram tap reads as
 * "you", a web operatorId is shown verbatim, same as the audit trail.
 */
export function resolvedCardHtml(names: Names, resolution: Pick<Resolution, "action" | "by" | "at">): string {
  const head = RESOLUTION_HEAD[resolution.action] ?? "✅ Resolved";
  const who = humanizeOperator(resolution.by);
  return [
    `${head} by ${esc(who)} · ${esc(fmtTime(resolution.at))}${names.project ? ` · ${esc(names.project)}` : ""}`,
    esc(names.run),
  ].join("\n");
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

/** The head phrase for a gate (shared by the card + the digest). Takes the
 *  whole item, not just its kind, so a stuck-review escalation gets its own
 *  calm head rather than the generic per-kind one. */
export function gateHead(it: HitlItem): string {
  return headFor(it);
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

// ─── Daily digest (scheduled, distinct from the on-demand /inbox) ──────────

/** Ms until the next occurrence of `hour:00` local time (today if it hasn't
 *  passed yet, else tomorrow). Pure (takes `now` rather than reading the
 *  clock) so the scheduling math is unit-testable without faking timers. */
export function nextDigestDelayMs(hour: number, now: Date): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

const DIGEST_BAR_LEN = 10;

/** A block-character mini bar (10 cells) showing spend against a cap. Mirrors
 *  the web Keys & Budget meter's shape in the only form Telegram can render —
 *  filled/empty characters, no color. */
function miniBar(spentUsd: number, capUsd: number): string {
  const pct = capUsd > 0 ? Math.min(1, spentUsd / capUsd) : 0;
  const filled = Math.round(pct * DIGEST_BAR_LEN);
  return "▓".repeat(filled) + "░".repeat(DIGEST_BAR_LEN - filled);
}

/**
 * The scheduled daily digest — distinct from the on-demand `/inbox` (`digestText`
 * above): a fixed-time evening ping rather than something the operator asks for.
 * Always exactly 3 summary sentences (the single thing most needing attention,
 * run counts, and how many decisions remain open) plus a spend line — a mini
 * bar only when at least one project has a daily cap set (nothing to bar
 * against otherwise, same as the web panel's "No limit set"). Pure; caller
 * resolves gates/counts/spend. `gates` should already be sorted
 * longest-waiting-first so `gates[0]` is genuinely "most needing attention".
 */
export function dailyDigestHtml(d: {
  hour: number;
  gates: { head: string; run: string }[];
  running: number;
  done: number;
  spentUsd: number;
  capUsd: number | null;
}): string {
  const hourLabel = `${String(d.hour).padStart(2, "0")}:00`;
  const top = d.gates[0];
  const s1 = top ? `${esc(top.head)} on ${esc(top.run)} needs you most.` : "Nothing needs a decision right now.";
  const s2 = `${d.running} run${d.running === 1 ? "" : "s"} active, ${d.done} finished today.`;
  const s3 =
    d.gates.length > 1
      ? `${d.gates.length} decisions are open in total.`
      : d.gates.length === 1
        ? "That's the only open decision."
        : "Autonomy is running the rest without you.";
  const spendLine =
    d.capUsd != null && d.capUsd > 0
      ? `<code>${miniBar(d.spentUsd, d.capUsd)}</code> $${d.spentUsd.toFixed(2)} of $${d.capUsd.toFixed(2)} spent today`
      : `$${d.spentUsd.toFixed(2)} spent today`;
  return [`🟢 <b>DIGEST · ${hourLabel}</b>`, "", `${s1} ${s2} ${s3}`, "", spendLine].join("\n");
}
