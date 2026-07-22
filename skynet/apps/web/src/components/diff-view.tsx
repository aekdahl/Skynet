import { useEffect, useRef, useState } from "react";
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

export function DiffView({
  runId,
  add,
  del,
  defaultOpen = false,
}: {
  runId: string;
  add: number;
  del: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<RunDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null);
    setData(null);
    fetchRunDiff(runId)
      .then((d) => live && setData(d))
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
  }, [open, runId, nonce]);

  const files = data ? parseUnifiedDiff(data.patch) : [];
  const nFiles = data ? data.files.length : 0;

  return (
    <div className="dv-wrap">
      <button className="dv-toggle mono" onClick={() => setOpen((o) => !o)}>
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
            {files.map((f) => (
              <div key={f.path} className="dv-file">
                <div className="dv-file-head mono">
                  <span className="dv-path">{f.path}</span>
                  <span className="dv-stat">
                    <span className="diff-add">+{f.add}</span> <span className="diff-del">−{f.del}</span>
                  </span>
                </div>
                <div className="dv-body mono">
                  {f.lines.map((l, i) => (
                    <div key={i} className={"dv-line dv-" + l.kind}>
                      <span className="dv-ln">{l.kind === "hunk" ? "" : (l.oldNo ?? "")}</span>
                      <span className="dv-ln">{l.kind === "hunk" ? "" : (l.newNo ?? "")}</span>
                      <span className="dv-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                      <span className="dv-code">{l.text || " "}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
