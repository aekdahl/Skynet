import { useEffect, useRef, useState } from "react";
import type { DiffWalkthrough, MergeBrief } from "@skynet/shared";
import { fetchRunDiff, type RunDiff } from "../lib/client";

// A GitHub-style unified-diff viewer for a diff/merge review gate. The patch is
// NOT in the snapshot (it would bloat it) — it's fetched lazily from
// GET /api/runs/:id/diff the first time the operator opens the diff.

type DiffLine = { kind: "ctx" | "add" | "del" | "hunk"; text: string; oldNo?: number; newNo?: number };
type DiffFile = { path: string; add: number; del: number; lines: DiffLine[] };

function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1]! : raw.replace("diff --git ", ""), add: 0, del: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode")
    ) {
      continue; // file metadata — path already captured
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), newNo });
      cur.add++;
      newNo++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), oldNo });
      cur.del++;
      oldNo++;
    } else {
      cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  return files;
}

/** Group a walkthrough's comments by file, splitting each file's list into
 *  line-anchored (rendered inline, next to the matching line) vs file-level
 *  (no line, or a line the rendered diff never shows — e.g. outside any
 *  hunk's context) — the latter render once under that file's head instead. */
function commentsByFile(walkthrough: DiffWalkthrough | null | undefined, files: DiffFile[]) {
  const byFile = new Map<string, { anchored: Map<number, string[]>; loose: string[] }>();
  if (!walkthrough) return byFile;
  const linesByFile = new Map(files.map((f) => [f.path, new Set(f.lines.map((l) => l.newNo).filter((n): n is number => n != null))]));
  for (const c of walkthrough.comments) {
    if (!byFile.has(c.file)) byFile.set(c.file, { anchored: new Map(), loose: [] });
    const bucket = byFile.get(c.file)!;
    const knownLines = linesByFile.get(c.file);
    if (c.line != null && knownLines?.has(c.line)) {
      if (!bucket.anchored.has(c.line)) bucket.anchored.set(c.line, []);
      bucket.anchored.get(c.line)!.push(c.note);
    } else {
      bucket.loose.push(c.note);
    }
  }
  return byFile;
}

export function DiffView({
  runId,
  patch,
  files: capturedFiles,
  add,
  del,
  walkthrough,
  mergeBrief,
  defaultOpen = false,
}: {
  // Live mode: fetch the patch lazily by runId (the Inbox review gate).
  runId?: string;
  // Static mode: a patch captured at decision time (the audit trail, where the
  // worktree is gone and can't be re-fetched). When set, it renders directly.
  patch?: string;
  files?: string[];
  add: number;
  del: number;
  // The agent's own plain-English explanation of this diff, drafted once when
  // the review gate was raised (Orchestrator.draftDiffWalkthrough). Null when
  // it wasn't drafted (older gate, no consult support, or the draft failed) —
  // the raw diff below is always complete on its own regardless.
  walkthrough?: DiffWalkthrough | null;
  // Guided merge — the risk/mitigation read of this diff, drafted alongside
  // the walkthrough (Orchestrator.draftMergeBrief). Null for the same reasons
  // a walkthrough can be null; the picker in the resolve UI still works
  // without it (it just falls back to the default branch with no brief shown).
  mergeBrief?: MergeBrief | null;
  defaultOpen?: boolean;
}) {
  const isStatic = patch !== undefined;
  const [open, setOpen] = useState(defaultOpen);
  const [fetched, setFetched] = useState<RunDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (isStatic || !open || !runId) return;
    let live = true;
    setErr(null);
    setFetched(null);
    fetchRunDiff(runId)
      .then((d) => live && setFetched(d))
      .catch((e: unknown) => {
        // Surface the real reason so a 404 (server predates this endpoint — a
        // stale build) is obvious rather than a mystery "couldn't load".
        const status = (e as { status?: number })?.status;
        const msg = status ? `HTTP ${status}` : (e as Error)?.message || "network error";
        console.error("diff load failed:", e);
        if (live) setErr(msg);
      });
    return () => {
      live = false;
    };
  }, [isStatic, open, runId, nonce]);

  const data: RunDiff | null = isStatic
    ? { patch: patch ?? "", add, del, files: capturedFiles ?? [] }
    : fetched;
  const files = data ? parseUnifiedDiff(data.patch) : [];
  const nFiles = data ? data.files.length : 0;
  const commentMap = commentsByFile(walkthrough, files);
  const nComments = walkthrough?.comments.length ?? 0;

  return (
    <div className="dv-wrap">
      {mergeBrief && (
        <div className="dv-brief">
          <span className="dv-brief-badge mono" title="Synthesized from the diff, the auto-review verdict (if any), and the project's check config">MERGE BRIEF</span>
          <p className="dv-brief-summary">{mergeBrief.summary}</p>
          {mergeBrief.risks.length > 0 && (
            <div className="dv-brief-section">
              <span className="dv-brief-label mono">Risks</span>
              <ul className="dv-brief-list dv-brief-risks">
                {mergeBrief.risks.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
          {mergeBrief.mitigations.length > 0 && (
            <div className="dv-brief-section">
              <span className="dv-brief-label mono">Mitigations</span>
              <ul className="dv-brief-list dv-brief-mitigations">
                {mergeBrief.mitigations.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {walkthrough && (
        <div className="dv-walkthrough">
          <span className="dv-walkthrough-badge mono" title="Drafted by the agent that made this change">AGENT SUMMARY</span>
          <p className="dv-walkthrough-text">{walkthrough.summary}</p>
          {nComments > 0 && !open && (
            <p className="dv-walkthrough-hint">
              {nComments} inline note{nComments === 1 ? "" : "s"} — view changes to see {nComments === 1 ? "it" : "them"}.
            </p>
          )}
        </div>
      )}
      <button className="dv-toggle mono" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="dv-caret">{open ? "▾" : "▸"}</span> {open ? "Hide changes" : "View changes"}
        <span className="dv-toggle-stat">
          <span className="diff-add">+{add}</span> <span className="diff-del">−{del}</span>
          {data ? " · " + nFiles + " file" + (nFiles === 1 ? "" : "s") : ""}
        </span>
      </button>
      {open &&
        (err ? (
          <p className="dv-empty">
            Couldn't load the diff ({err}) — review it on the branch.{" "}
            <button className="dv-retry" onClick={() => setNonce((n) => n + 1)}>Retry</button>
          </p>
        ) : !data ? (
          <p className="dv-empty">Loading diff…</p>
        ) : files.length === 0 ? (
          <p className="dv-empty">No file changes on this branch{data.patch ? "." : " (no git worktree)."}</p>
        ) : (
          <div className="dv">
            {files.map((f) => {
              const fileComments = commentMap.get(f.path);
              return (
                <div key={f.path} className="dv-file">
                  <div className="dv-file-head mono">
                    <span className="dv-path">{f.path}</span>
                    <span className="dv-stat">
                      <span className="diff-add">+{f.add}</span> <span className="diff-del">−{f.del}</span>
                    </span>
                  </div>
                  {fileComments?.loose.map((note, i) => (
                    <p key={i} className="dv-comment dv-comment-file">🤖 {note}</p>
                  ))}
                  <div className="dv-body mono">
                    {f.lines.map((l, i) => (
                      <div key={i}>
                        <div className={"dv-line dv-" + l.kind}>
                          <span className="dv-ln">{l.kind === "hunk" ? "" : (l.oldNo ?? "")}</span>
                          <span className="dv-ln">{l.kind === "hunk" ? "" : (l.newNo ?? "")}</span>
                          <span className="dv-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                          <span className="dv-code">{l.text || " "}</span>
                        </div>
                        {l.newNo != null &&
                          fileComments?.anchored.get(l.newNo)?.map((note, j) => (
                            <p key={j} className="dv-comment dv-comment-line">🤖 {note}</p>
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
