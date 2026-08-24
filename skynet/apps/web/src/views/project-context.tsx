import { useEffect, useRef, useState } from "react";
import type { Project, ProjectContextEntry } from "@skynet/shared";
import * as api from "../lib/client";

// The project-detail "Context" tab: raw meeting notes/emails/docs the operator
// pastes or uploads, kept verbatim as a running list (never edited by the
// model — delete + re-add if wrong). A separate LLM pass condenses the
// accumulated set into Project.contextSummary (steward/context.ts), shown at
// the top — that's the short primer that actually rides agent prompts and
// Steward's own grounding. The raw list is source material, not what agents
// read directly.

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function ProjectContextView({ project }: { project: Project }) {
  const [entries, setEntries] = useState<ProjectContextEntry[] | null>(null); // null = loading
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api
      .listContextEntries(project.id)
      .then(setEntries)
      .catch((e: unknown) => setErr((e as Error)?.message || "Couldn't load context."));
  };

  useEffect(() => {
    setEntries(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- project.id is the only real dep; load is stable per-render
  }, [project.id]);

  const paste = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const entry = await api.addContextEntry(project.id, { label: label.trim() || undefined, content: content.trim() });
      setEntries((es) => [entry, ...(es ?? [])]);
      setLabel("");
      setContent("");
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save that note.");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const entry = await api.uploadContextEntry(project.id, file);
      setEntries((es) => [entry, ...(es ?? [])]);
    } catch (e) {
      setErr((e as Error)?.message || `Couldn't read "${file.name}".`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.deleteContextEntry(project.id, id);
      setEntries((es) => (es ?? []).filter((e) => e.id !== id));
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't delete that entry.");
    }
  };

  // The server's response already carries the updated summary, but the global
  // store (not this component) owns `project` — it'll pick up the change via
  // the same `project.upserted` WS event every other project mutation relies
  // on, so nothing to apply locally here beyond clearing the busy state.
  const refresh = async () => {
    setRefreshing(true);
    setErr(null);
    try {
      await api.refreshProjectContext(project.id);
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't refresh the summary.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="prj-ctx">
      <div className="prj-ctx-summary">
        <div className="prj-ctx-summary-head">
          <span className="prj-ctx-summary-title">Condensed context</span>
          {project.contextSummaryUpdatedAt && (
            <span className="prj-ctx-summary-updated mono">updated {timeAgo(project.contextSummaryUpdatedAt)}</span>
          )}
          <button className="btn btn-ghost btn-sm" disabled={refreshing || !entries?.length} onClick={refresh}>
            {refreshing ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
        {project.contextSummary ? (
          <p className="prj-ctx-summary-body">{project.contextSummary}</p>
        ) : (
          <p className="kb-empty">
            No summary yet — paste a note or upload a doc below, and Skynet will condense it into a short primer every
            agent (and Steward) reads.
          </p>
        )}
      </div>

      <div className="prj-ctx-add">
        <input
          className="qx-input"
          placeholder="Label (optional) — e.g. 'Kickoff call, 8/12'"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
        <textarea
          className="qx-input prj-ctx-textarea"
          placeholder="Paste meeting notes, an email, anything that shapes what this project is aiming at…"
          rows={4}
          value={content}
          disabled={busy}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="prj-ctx-add-actions">
          <button className="btn btn-primary btn-sm" disabled={!content.trim() || busy} onClick={paste}>
            Add note
          </button>
          <label className="btn btn-ghost btn-sm prj-ctx-upload-label">
            Upload file
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.pdf,.docx"
              disabled={busy}
              className="prj-ctx-upload-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
          <span className="prj-ctx-hint mono">.txt · .md · .pdf · .docx</span>
        </div>
      </div>

      {err && <div className="prd-path-err">{err}</div>}

      {entries === null ? (
        <div className="kb-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="kb-empty">Nothing added yet.</div>
      ) : (
        <div className="prj-ctx-list">
          {entries.map((e) => (
            <div key={e.id} className="prj-ctx-entry">
              <div className="prj-ctx-entry-head">
                <span className={"prj-ctx-badge prj-ctx-badge-" + e.source}>{e.source === "upload" ? "upload" : "paste"}</span>
                <span className="prj-ctx-entry-label">{e.label}</span>
                <span className="prj-ctx-entry-date mono">{timeAgo(e.createdAt)}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(e.id)}>
                  Delete
                </button>
              </div>
              <div className="prj-ctx-entry-body">{e.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
