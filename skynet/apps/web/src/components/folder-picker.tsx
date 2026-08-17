import { useEffect, useState } from "react";
import { browseFolder, type FsEntry, type FsListing } from "../lib/client";

// A folder picker for connecting a project to a local repo. Two ways in, because
// browsing alone is painful over a VM/remote (no mouse-friendly tree, or a fresh
// home with no subfolders): (1) type/paste an absolute path straight into the
// field, or (2) open the modal to browse AND/OR type a path to jump to. Backed by
// /api/fs/list (desktop: server = this machine); `~` is expanded server-side.

export function FolderPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="qx-row" style={{ gap: 8, alignItems: "stretch" }}>
        <input
          className="qx-input"
          placeholder="Type or paste a folder path (e.g. ~/code/app), or Browse…"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12.5 }}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Browse…
        </button>
        {value && (
          <button type="button" className="btn btn-ghost" title="Clear" onClick={() => onChange("")}>
            ✕
          </button>
        )}
      </div>
      {open && (
        <BrowseModal
          initial={value || undefined}
          onClose={() => setOpen(false)}
          onPick={(p) => {
            onChange(p);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function BrowseModal({
  initial,
  onPick,
  onClose,
}: {
  initial?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(initial ?? ""); // the editable path field

  const load = (path?: string) => {
    setLoading(true);
    browseFolder(path)
      .then((l) => {
        setListing(l);
        setDraft(l.path); // reflect where we actually landed
      })
      .catch(() => setListing(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(initial), [initial]);

  const cur = listing?.path ?? "";
  // What "Use this folder" would pick: the typed path if edited, else the listing.
  const chosen = draft.trim() || cur;
  // Enable use only when the resolved dir exists and matches what's typed (so a
  // typo/nonexistent path is caught before it becomes a broken project).
  const canUse = !!chosen && !!listing?.exists && draft.trim() === cur;
  const typedButNotLoaded = draft.trim() !== "" && draft.trim() !== cur;

  return (
    <div className="fp-backdrop" onClick={onClose} style={BACKDROP}>
      <div className="fp-modal" onClick={(e) => e.stopPropagation()} style={MODAL}>
        <div style={HEAD}>
          <b>Choose a project folder</b>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: "2px 8px" }}>✕</button>
        </div>

        {/* Editable path bar — type/paste + Enter or Go to jump there. */}
        <div style={PATHROW}>
          <input
            style={PATHINPUT}
            value={draft}
            placeholder="/absolute/path or ~/path — type and press Enter"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(draft.trim() || undefined)}
          />
          <button className="btn btn-ghost" style={{ padding: "4px 10px" }} onClick={() => load(draft.trim() || undefined)}>
            Go
          </button>
        </div>

        <div style={LIST}>
          {listing?.parent && (
            <button style={ROW} onClick={() => load(listing.parent!)}>
              <span style={{ opacity: 0.7 }}>↑</span> <span>..</span>
            </button>
          )}
          {loading && <div style={{ padding: 12, color: "var(--muted)" }}>Loading…</div>}
          {!loading && listing && !listing.exists && (
            <div style={{ padding: 12, color: "var(--warn, #d88)" }}>
              Folder not found — check the path, or navigate to it.
            </div>
          )}
          {!loading && listing?.exists && listing.entries.length === 0 && (
            <div style={{ padding: 12, color: "var(--muted)" }}>No subfolders here.</div>
          )}
          {!loading &&
            listing?.entries.map((e: FsEntry) => (
              <button key={e.path} style={ROW} onClick={() => load(e.path)} title={e.path}>
                <span style={{ opacity: 0.7 }}>📁</span>
                <span style={{ flex: 1, textAlign: "left" }}>{e.name}</span>
                {e.isGitRepo && <span style={GITBADGE}>◈ git</span>}
              </button>
            ))}
        </div>

        <div style={FOOT}>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>
            {listing?.isGitRepo
              ? "◈ This folder is a git repo — runs branch & PR here."
              : typedButNotLoaded
                ? "Press Enter / Go to open the typed path."
                : "Pick the folder your runs should work in."}
          </span>
          <button className="btn btn-primary" disabled={!canUse} onClick={() => onPick(chosen)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline styles (mono/dark, self-contained — no styles.css dependency).
const BACKDROP: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 2147483646,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const MODAL: React.CSSProperties = {
  width: "min(560px, calc(100vw - 32px))", maxHeight: "70vh", display: "flex", flexDirection: "column",
  background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 12,
  fontFamily: "var(--font-ui)", overflow: "hidden",
};
const HEAD: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "12px 14px", borderBottom: "1px solid var(--line-soft)",
};
const PATHROW: React.CSSProperties = {
  display: "flex", gap: 8, alignItems: "center",
  padding: "8px 14px", borderBottom: "1px solid var(--line-soft)",
};
const PATHINPUT: React.CSSProperties = {
  flex: 1, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--line)",
  borderRadius: 8, padding: "6px 10px", fontFamily: "var(--font-mono, monospace)", fontSize: 12,
};
const LIST: React.CSSProperties = { overflowY: "auto", flex: 1, padding: 6 };
const ROW: React.CSSProperties = {
  display: "flex", gap: 10, alignItems: "center", width: "100%",
  padding: "8px 10px", background: "transparent", border: "none",
  color: "var(--text)", cursor: "pointer", borderRadius: 8, fontSize: 13, fontFamily: "var(--font-ui)",
};
const GITBADGE: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "var(--ok)",
  border: "1px solid var(--line)", borderRadius: 5, padding: "1px 6px",
};
const FOOT: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  gap: 10, padding: "10px 14px", borderTop: "1px solid var(--line-soft)",
};
