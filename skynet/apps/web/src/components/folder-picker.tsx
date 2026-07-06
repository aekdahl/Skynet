import { useEffect, useState } from "react";
import { browseFolder, type FsEntry, type FsListing } from "../lib/client";

// A folder *picker* for connecting a project to a local repo — select, don't
// type. Backed by the server's /api/fs/list (desktop: server = this machine).
// Renders as a field showing the chosen path + a "Choose…" button that opens a
// small browse modal (navigate dirs, git repos badged, pick the current dir).

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
          readOnly
          placeholder="No repo folder — click Choose (optional)"
          value={value}
          style={{ flex: 1, cursor: "default" }}
          onClick={() => setOpen(true)}
        />
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Choose…
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

  const load = (path?: string) => {
    setLoading(true);
    browseFolder(path)
      .then((l) => setListing(l))
      .catch(() => setListing(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(initial), [initial]);

  const cur = listing?.path ?? "";

  return (
    <div className="fp-backdrop" onClick={onClose} style={BACKDROP}>
      <div className="fp-modal" onClick={(e) => e.stopPropagation()} style={MODAL}>
        <div style={HEAD}>
          <b>Choose a project folder</b>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: "2px 8px" }}>✕</button>
        </div>
        <div style={PATHBAR} title={cur}>{cur || "…"}</div>
        <div style={LIST}>
          {listing?.parent && (
            <button style={ROW} onClick={() => load(listing.parent!)}>
              <span style={{ opacity: 0.7 }}>↑</span> <span>..</span>
            </button>
          )}
          {loading && <div style={{ padding: 12, color: "var(--faint)" }}>Loading…</div>}
          {!loading && listing?.entries.length === 0 && (
            <div style={{ padding: 12, color: "var(--faint)" }}>No subfolders here.</div>
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
          <span style={{ color: "var(--faint)", fontSize: 11 }}>
            Pick the folder your agents should work in.
          </span>
          <button className="btn btn-primary" disabled={!cur} onClick={() => onPick(cur)}>
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
const PATHBAR: React.CSSProperties = {
  padding: "8px 14px", fontFamily: "var(--font-mono, monospace)", fontSize: 12,
  color: "var(--muted)", borderBottom: "1px solid var(--line-soft)",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
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
