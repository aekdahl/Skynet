import { Fragment, useEffect, useState } from "react";
import type { TaskRun, HitlItem } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtWait, hitlHeadline, KIND_META, openQueue, projectName, sortForInbox, waitedSecs } from "../lib/derive";
import { isTypingTarget } from "../lib/keys";
import { useChoice } from "../components/confirm";
import { RiskChip } from "../components/hitl-context";
import { DiffView } from "../components/diff-view";

export function QueueCard({
  item,
  agent,
  now,
  selected,
  onOpen,
  modifyTrigger,
}: {
  item: HitlItem;
  agent: TaskRun | undefined;
  now: number;
  selected: boolean;
  onOpen: () => void;
  // Bumped by the parent (the `m` keyboard shortcut on the selected card) to
  // toggle this card's modify panel — the same `setMode(mode === "modify" ?
  // null : "modify")` the Modify / Help & resume buttons already call, just
  // triggered externally. 0/undefined is the "no request yet" rest state, so
  // the mount-time effect run never fires it.
  modifyTrigger?: number;
}) {
  const { resolveHitl, streamAgentMessage, readOnly, projects } = useStore();
  const choice = useChoice();
  const k = hitlHeadline(item);
  const [mode, setMode] = useState<null | "modify" | "chat" | "remember">(null);
  const [draft, setDraft] = useState("");
  // Separate from `draft` (guidance TO the agent) — a memory note is a durable
  // preference statement, not an instruction, and the two shouldn't bleed into
  // each other if an operator switches panels mid-thought.
  const [noteDraft, setNoteDraft] = useState("");
  const [msgs, setMsgs] = useState<Array<{ who: "you" | "agent"; text: string }>>([]);
  const agentName = agent?.name ?? item.runId;
  // Guided merge — the target branch this diff/merge approval integrates
  // into. Prefilled with the gate's own default (the project's integration
  // branch, the GitHub PR base, or — on a merge retry — whatever branch that
  // attempt already targeted) so a plain Approve behaves exactly like today
  // unless the operator edits it.
  const isMergeable = item.kind === "diff" || item.kind === "merge";
  const [branchDraft, setBranchDraft] = useState(() => item.diff?.defaultTargetBranch ?? "");
  const approveExtra = isMergeable && branchDraft.trim() ? { targetBranch: branchDraft.trim() } : undefined;

  useEffect(() => {
    if (modifyTrigger) setMode((m) => (m === "modify" ? null : "modify"));
  }, [modifyTrigger]); // eslint-disable-line react-hooks/exhaustive-deps -- functional updater reads mode, doesn't need it as a dep

  const send = async () => {
    if (!draft.trim() || !agent) return;
    const text = draft.trim();
    const runId = agent.id;
    setMsgs((m) => [...m, { who: "you", text }, { who: "agent", text: "" }]);
    setDraft("");
    const appendToLast = (chunk: string) =>
      setMsgs((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.who === "agent") next[next.length - 1] = { who: "agent", text: last.text + chunk };
        return next;
      });
    try {
      await streamAgentMessage(runId, text, appendToLast);
    } catch {
      appendToLast("(couldn't get a reply)");
    }
  };

  const resolved = item.resolvedAt != null;

  return (
    <article
      className={
        "qcard" + (selected ? " sel" : "") + (resolved ? " leaving" : "")
      }
    >
      <div className="qcard-head">
        <span className="kind-chip" style={{ color: k.color, borderColor: k.color }}>
          {k.label}
        </span>
        <RiskChip risk={item.risk} />
        {agent && <span className="qcard-project" title="Project">{projectName(agent.projectId, projects)}</span>}
        <button className="qcard-agent" onClick={onOpen}>
          {agentName}
        </button>
        <span className="qcard-wait">{fmtWait(waitedSecs(item, now))}</span>
      </div>
      <h3 className="qcard-title">{item.title}</h3>
      {item.rationale && <p className="qcard-reason">💭 {item.rationale}</p>}
      <p className="qcard-why">{item.why}</p>

      {item.command && <pre className="qcard-code">$ {item.command}</pre>}
      {item.output && item.kind === "merge" && (
        <p className="qcard-plan-label mono">Conflict (captured before the merge was aborted) — Modify sends this to the agent as-is</p>
      )}
      {item.output && <pre className="qcard-code qcard-output">{item.output}</pre>}

      {item.flags && item.flags.length > 0 && (
        <div className="qcard-flags">
          <span className="qcard-flags-label mono">{item.kind === "merge" ? "Conflicts in" : "Flagged"}</span>
          {item.flags.map((f, i) => (
            <span key={i} className={"flag-chip" + (item.kind === "merge" ? " flag-file mono" : "")}>{f}</span>
          ))}
        </div>
      )}

      {item.steps && (
        <>
          <p className="qcard-plan-label mono">Proposed plan — approve before the agent writes</p>
          <ol className="qcard-steps">
            {item.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}

      {item.diff && isMergeable && (
        <DiffView runId={item.runId} add={item.diff.add} del={item.diff.del} walkthrough={item.diff.walkthrough} mergeBrief={item.diff.mergeBrief} />
      )}

      {item.diff && isMergeable && !resolved && (
        <label className="qcard-branch">
          <span className="qcard-branch-label mono">Merge into</span>
          <input
            className="qx-input qcard-branch-input mono"
            value={branchDraft}
            onChange={(e) => setBranchDraft(e.target.value)}
            placeholder={item.diff.defaultTargetBranch ?? "(default)"}
            spellCheck={false}
          />
        </label>
      )}

      {item.kind === "escalation" ? (
        <div className="qcard-actions">
          <button
            className={"btn btn-primary" + (mode === "modify" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "modify" ? null : "modify")}
          >
            Help &amp; resume
          </button>
          <button
            className="btn"
            title="Hand this run to a different runner — choose whether to keep its work or start clean"
            disabled={readOnly}
            onClick={async () => {
              const picked = await choice({
                title: "Reassign to a different runner",
                body: "How should the new runner pick this up?",
                options: [
                  {
                    value: "continue",
                    label: "Continue in this worktree",
                    hint: "The new runner picks up the branch's committed work where the last one left off.",
                    primary: true,
                  },
                  {
                    value: "reset",
                    label: "Start clean",
                    hint: "Discards this worktree's work — the new runner starts the task fresh on a new branch.",
                    danger: true,
                  },
                ],
              });
              if (picked) resolveHitl(item.id, "reassign", { guidance: draft.trim(), resetWork: picked === "reset" });
            }}
          >
            Reassign
          </button>
          <button className="btn btn-danger" disabled={readOnly} onClick={() => resolveHitl(item.id, "reject")}>
            Stop run
          </button>
          <button
            className={"btn btn-ghost" + (mode === "chat" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "chat" ? null : "chat")}
          >
            Chat
          </button>
          <button className="btn btn-ghost" onClick={onOpen}>
            Open agent
          </button>
          <button
            className="btn btn-ghost"
            title="Clear this card — no operation on the run (doesn't stop, resume, or reassign)"
            disabled={readOnly}
            onClick={() => resolveHitl(item.id, "dismiss")}
          >
            Dismiss
          </button>
        </div>
      ) : item.options ? (
        <div className="qcard-actions">
          {item.options.map((opt, i) => (
            <button
              key={i}
              className={"btn" + (i === item.recommended ? " btn-primary" : "")}
              disabled={readOnly}
              onClick={() => resolveHitl(item.id, "option", { optionIndex: i })}
            >
              “{opt}”
              {i === item.recommended && <span className="rec">rec</span>}
            </button>
          ))}
          <button
            className={"btn btn-ghost" + (mode === "modify" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "modify" ? null : "modify")}
          >
            Modify
          </button>
          <button
            className={"btn btn-ghost" + (mode === "chat" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "chat" ? null : "chat")}
          >
            Chat
          </button>
          <button className="btn btn-ghost" onClick={onOpen}>
            Open agent
          </button>
        </div>
      ) : (
        <div className="qcard-actions">
          <button
            className="btn btn-primary"
            disabled={readOnly}
            onClick={() => resolveHitl(item.id, "approve", approveExtra)}
          >
            Approve
          </button>
          {item.kind === "approval" && item.command && item.risk !== "high" && (
            <button
              className="btn btn-ghost"
              title="Approve now and always auto-approve this exact command in this project"
              disabled={readOnly}
              onClick={() => resolveHitl(item.id, "approve", { remember: true })}
            >
              Always allow
            </button>
          )}
          <button
            className="btn btn-danger"
            disabled={readOnly}
            onClick={() => resolveHitl(item.id, "reject")}
          >
            Reject
          </button>
          <button
            className={"btn btn-ghost" + (mode === "modify" ? " btn-lit" : "")}
            title={item.kind === "merge" ? "Have the agent resolve the conflict, using the diff captured below" : undefined}
            onClick={() => setMode(mode === "modify" ? null : "modify")}
          >
            {item.kind === "merge" ? "Ask agent to fix" : "Modify"}
          </button>
          <button
            className={"btn btn-ghost" + (mode === "chat" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "chat" ? null : "chat")}
          >
            Chat
          </button>
          <button className="btn btn-ghost" onClick={onOpen}>
            Open agent
          </button>
          {/* Approve-with-memory (roadmap: "the Inbox becomes how policy/memory
              get authored"). Distinct from "Always allow" above — that writes a
              real auto-approve RULE for this exact command; this captures a
              free-form durable PREFERENCE ("this project prefers X"), which
              applies to any of the four everyday gate kinds, not just commands.
              One quiet toggle, not a forced field — never shown as the default,
              never blocks Approve. */}
          <button
            className={"btn btn-ghost" + (mode === "remember" ? " btn-lit" : "")}
            title="Approve and also note a durable preference for this project — captured for Memory v0 to adopt once it lands; nothing reads it back yet"
            onClick={() => setMode(mode === "remember" ? null : "remember")}
          >
            + Also remember
          </button>
        </div>
      )}

      {mode === "remember" && (
        <div className="qx">
          <textarea
            className="qx-input"
            rows={2}
            autoFocus
            placeholder="A durable preference this decision suggests — e.g. “this project prefers snake_case for Python files”…"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <div className="qx-row">
            <button
              className="btn btn-primary"
              disabled={!noteDraft.trim()}
              onClick={() => {
                resolveHitl(item.id, "approve", { memoryNote: noteDraft.trim() });
                setNoteDraft("");
              }}
            >
              Approve &amp; remember
            </button>
            <button className="btn btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "modify" && (
        <div className="qx">
          <textarea
            className="qx-input"
            rows={3}
            autoFocus
            placeholder={
              item.kind === "merge"
                ? "Optional — extra guidance for resolving the conflict below. Leave blank and the agent still sees the full conflict."
                : "Adjust the instruction — the agent resumes with this guidance…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="qx-row">
            <button
              className="btn btn-primary"
              disabled={readOnly}
              onClick={() =>
                resolveHitl(item.id, "modify", { guidance: draft.trim() })
              }
            >
              {item.kind === "merge" ? "Ask agent to fix" : "Send & resume"}
            </button>
            <button className="btn btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "chat" && (
        <div className="qx">
          <div className="qx-thread">
            <div className="qx-msg qx-agent">
              <span className="qx-who mono">{agentName}</span>
              {item.why}
            </div>
            {msgs.map((m, i) => (
              <div
                key={i}
                className={"qx-msg " + (m.who === "you" ? "qx-you" : "qx-agent")}
              >
                <span className="qx-who mono">
                  {m.who === "you" ? "you" : agentName}
                </span>
                {m.text}
              </div>
            ))}
          </div>
          <div className="qx-row">
            <input
              className="qx-input qx-line"
              placeholder="Ask or instruct…"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button className="btn" onClick={send}>
              Send
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// The gate kinds that surface a run into the Inbox for a human decision. Shown
// on the empty state so first-run users learn the gate vocabulary before the
// first gate fires (question/escalation are omitted — they're rarer follow-ups,
// not the four everyday sign-offs). Labels/colors come from KIND_META.
const EMPTY_GATE_KINDS: { kind: HitlItem["kind"]; blurb: string }[] = [
  { kind: "approval", blurb: "a command approval before it runs" },
  { kind: "plan", blurb: "a plan sign-off before it writes code" },
  { kind: "diff", blurb: "a diff review before it merges" },
  { kind: "merge", blurb: "a merge conflict it can't resolve alone" },
];

const HINTS_DISMISSED_KEY = "skynet.queueHintsDismissed";

export function QueueView({
  selectedIdx,
  onSelectIdx,
  onOpen,
  now,
}: {
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  onOpen: (id: string) => void;
  now: number;
}) {
  const { queue, runs, resolveHitl } = useStore();
  // A single flat, index-ordered array (not two separately-indexed lists) so
  // j/k/a/r/m keyboard nav and `selectedIdx` keep working unchanged — the
  // Approvals/Other grouping (see sortForInbox) is purely a render-time
  // section split (see the section headers in the list below).
  const open = sortForInbox(openQueue(queue), now);
  const approvalCount = open.filter((it) => it.kind !== "escalation").length;
  const otherCount = open.length - approvalCount;
  // Resolved *today* (since local midnight) — a bounded, self-resetting momentum
  // stat. The old count was every resolved gate the store still held, so it only
  // ever grew and never reset (it was mislabeled "this session").
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const resolvedCount = queue.filter((q) => q.resolvedAt != null && q.resolvedAt >= startOfToday).length;
  // Clear-all = reject every still-open gate. Consequential (each reject bounces
  // that run), so it's a two-step: arm, then confirm.
  const [armed, setArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [hintsDismissed, setHintsDismissed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(HINTS_DISMISSED_KEY) === "1",
  );
  const dismissHints = () => {
    localStorage.setItem(HINTS_DISMISSED_KEY, "1");
    setHintsDismissed(true);
  };
  // `m` toggles the selected card's modify panel. Keyed by item id (not just
  // a bare counter) so a *different* gate that lands on the same list index
  // right after a resolve doesn't inherit a stale nonzero trigger and pop
  // its modify panel open on mount.
  const [modifyRequest, setModifyRequest] = useState<{ id: string; nonce: number } | null>(null);

  // Keep the selection in bounds as the list shrinks (a resolve, a reconnect
  // that drops a stale item, …) so `selectedIdx` never points past the end.
  useEffect(() => {
    if (selectedIdx > open.length - 1) onSelectIdx(Math.max(0, open.length - 1));
  }, [open.length, selectedIdx, onSelectIdx]);

  // j/k navigate, ↵ opens the run, a/r/m act on the selected gate — the exact
  // same resolveHitl/setMode calls the card's own buttons make, just fired
  // from the keyboard. Scoped to this view (mounted only while the Inbox is
  // open) and skipped while the operator is typing in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open.length === 0 || isTypingTarget(e.target)) return;
      const it = open[selectedIdx];
      switch (e.key) {
        case "j":
          e.preventDefault();
          onSelectIdx(Math.min(selectedIdx + 1, open.length - 1));
          break;
        case "k":
          e.preventDefault();
          onSelectIdx(Math.max(selectedIdx - 1, 0));
          break;
        case "Enter":
          if (!it) return;
          e.preventDefault();
          onOpen(it.runId);
          break;
        case "a":
          if (!it || it.kind === "escalation") return;
          e.preventDefault();
          // Options-kind cards have no bare "approve" button — the closest
          // equivalent is the recommended (or first) option's own button.
          if (it.options) resolveHitl(it.id, "option", { optionIndex: it.recommended ?? 0 });
          else resolveHitl(it.id, "approve");
          break;
        case "r":
          // Options-kind cards have no reject button (the operator picks an
          // option instead) — leave that case alone rather than inventing one.
          if (!it || it.options) return;
          e.preventDefault();
          resolveHitl(it.id, "reject");
          break;
        case "m":
          if (!it) return;
          e.preventDefault();
          setModifyRequest((prev) => ({ id: it.id, nonce: (prev?.id === it.id ? prev.nonce : 0) + 1 }));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selectedIdx, onSelectIdx, onOpen, resolveHitl]);

  const rejectAll = async () => {
    setClearing(true);
    // Sequential, not Promise.all — each reject resumes its agent; don't stampede.
    for (const it of open) {
      try {
        await resolveHitl(it.id, "reject");
      } catch {
        /* already resolved / gone — keep going */
      }
    }
    setClearing(false);
    setArmed(false);
  };

  return (
    <section className="queue">
      {!hintsDismissed && open.length > 0 && (
        <div className="queue-hintbar" role="note">
          <span className="queue-hintbar-item"><kbd>j</kbd><kbd>k</kbd> navigate</span>
          <span className="queue-hintbar-item"><kbd>↵</kbd> open</span>
          <span className="queue-hintbar-item"><kbd>a</kbd> approve</span>
          <span className="queue-hintbar-item"><kbd>r</kbd> reject</span>
          <span className="queue-hintbar-item"><kbd>m</kbd> modify</span>
          <button className="queue-hintbar-dismiss" title="Dismiss" onClick={dismissHints}>
            ✕
          </button>
        </div>
      )}
      <div className="queue-readout">
        <div className="readout-block">
          <span className="readout-num">{open.length}</span>
          <span className="readout-label">
            runs waiting
            <br />
            on you
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-ok">{resolvedCount}</span>
          <span className="readout-label">
            resolved
            <br />
            today
          </span>
        </div>
        {open.length > 0 && (
          <div className="readout-actions">
            {armed ? (
              <>
                <span className="readout-confirm">Reject all {open.length} open?</span>
                <button className="btn btn-danger" disabled={clearing} onClick={rejectAll}>
                  {clearing ? "Rejecting…" : "Reject all"}
                </button>
                <button className="btn btn-ghost" disabled={clearing} onClick={() => setArmed(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-ghost" title="Reject every still-open gate" onClick={() => setArmed(true)}>
                Clear all
              </button>
            )}
          </div>
        )}
      </div>
      {open.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-mark">✓</span>
          <p>Queue clear — no human override required.</p>
          <p className="queue-empty-teach">When a run needs you, it arrives here as one of four gates:</p>
          <ul className="queue-empty-kinds">
            {EMPTY_GATE_KINDS.map(({ kind, blurb }) => {
              const k = KIND_META[kind];
              return (
                <li key={kind}>
                  <span className="kind-chip" style={{ color: k.color, borderColor: k.color }}>
                    {k.label}
                  </span>
                  <span className="queue-empty-blurb">{blurb}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="queue-list">
          {open.map((it, i) => (
            <Fragment key={it.id}>
              {/* A section header fires once, right before the first item of
                  its group — approvals always come first, so this only ever
                  transitions once (approvals → other), not per-item. */}
              {i === 0 && approvalCount > 0 && (
                <h2 className="queue-section">Approvals · {approvalCount}</h2>
              )}
              {it.kind === "escalation" && (i === 0 || open[i - 1]!.kind !== "escalation") && (
                <h2 className="queue-section">Other · {otherCount}</h2>
              )}
              <QueueCard
                item={it}
                agent={runs.find((a) => a.id === it.runId)}
                now={now}
                selected={i === selectedIdx}
                onOpen={() => onOpen(it.runId)}
                modifyTrigger={modifyRequest?.id === it.id ? modifyRequest.nonce : 0}
              />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
