import { useEffect, useMemo, useState } from "react";
import type { Project, RoadmapChecklistItemNode, RoadmapDoc, RoadmapProposal, Task } from "@skynet/shared";
import * as api from "../lib/client";
import type { RoadmapHistoryEntry } from "../lib/client";
import { useStore } from "../lib/store";
import { inline } from "../components/markdown";
import { groupRoadmapSections, machineBlocks, classifyMachineLine, type RoadmapSectionView } from "../kanban/roadmap-view";
import { RoadmapDrift } from "../kanban/roadmap-drift";

// The project-detail "Roadmap" tab — Phase 26 (TASK 29) rebuild. Was a
// single rendered-markdown view (RoadmapPhase, a progress ring, a
// shipped/current/pending read purely off checkbox counts); this is now a
// three-mode document interface (RENDERED/SOURCE/HISTORY) reading the REAL
// parsed doc (TASK 27's RoadmapDoc — per-line id/state/provenance), not raw
// markdown re-parsed client-side.
//
// One deliberate adaptation from this task's own brief, made explicit here
// rather than silently: the brief describes 4 line-state card variants
// (shipped/in-flight/unstartable/added-by-agent). The REAL data model TASK
// 27 shipped is a 3-state enum (`done`/`in_progress`/`todo` — see
// packages/shared/src/roadmap-doc.ts's RoadmapLineState) with agent
// authorship as a SEPARATE, cross-cutting field (author/authorRef/
// claimedByHuman), not a 4th state. This view renders 3 state-driven cards
// (done/in_progress/todo) with agent-authorship as an overlay on any of
// them (a dashed machine-border + KEEP·CLAIM AS MINE / REVERT THE COMMIT,
// exactly where the brief's "added-by-agent" card would have applied) —
// the real state a line is in and whether an agent wrote it are orthogonal
// facts, and forcing them into one enum would have meant inventing states
// the backend doesn't have.
//
// `acceptanceCriteria`/`taskIds`/`promisedDate`/`forecast` are real fields
// on RoadmapLine, but nothing in this codebase populates them yet (see that
// schema's own doc comment) — rendered when present, cleanly omitted when
// not, never a fabricated placeholder.

type RoadmapMode = "rendered" | "source" | "history" | "drift";

/** Typed a path + saved it, or cleared the override back to the default
 *  candidates. The empty state for "not_found" — shown either because
 *  there's no roadmap doc at all, or because an existing override now points
 *  at a file that's gone missing (renamed/deleted since it was set). */
function RoadmapPathPicker({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const { updateProject } = useStore();
  const [path, setPath] = useState(project.roadmapPath ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await updateProject(project.id, { roadmapPath: next });
      onSaved();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save that path.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-empty">
      {project.roadmapPath
        ? `No file at "${project.roadmapPath}" in this repo anymore.`
        : "No ROADMAP.md (or docs/ROADMAP.md) in this repo."}{" "}
      Point this tab at the real one — or ask Steward, e.g. "the roadmap is at docs/PLAN.md".
      <div className="prd-path-picker">
        <input
          className="qx-input"
          placeholder="e.g. docs/PLAN.md"
          value={path}
          disabled={busy}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path.trim() && !busy && save(path.trim())}
        />
        <button className="btn btn-primary btn-sm" disabled={!path.trim() || busy} onClick={() => save(path.trim())}>
          Use this file
        </button>
        {project.roadmapPath && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPath(""); void save(null); }}>
            Clear override
          </button>
        )}
      </div>
      {err && <div className="prd-path-err">{err}</div>}
    </div>
  );
}

function RoadmapEmptyState({
  result,
  project,
  onRetry,
}: {
  result: Exclude<api.ProjectRoadmapResult, { state: "ok" }>;
  project: Project;
  onRetry: () => void;
}) {
  switch (result.state) {
    case "unbound":
      return <div className="kb-empty">Connect a local folder or GitHub repo in ⚙ Settings to show its roadmap here.</div>;
    case "missing_local_repo":
      return <div className="kb-empty">This project's local folder isn't on disk — reclone or fix the path in Settings.</div>;
    case "not_found":
      return <RoadmapPathPicker project={project} onSaved={onRetry} />;
    case "github_error":
      return (
        <div className="kb-empty">
          Couldn't read the repo ({result.message}) — check the project's GitHub connection in Settings.
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
        </div>
      );
  }
}

// ─── provenance gutter ───────────────────────────────────────────────────
// "you"/a human name in text-faint, an agent/"skynet" identity in machine —
// the one shared visual language every card variant below uses.
function fmtAge(atMs: number, now: number): string {
  const sec = Math.max(0, Math.round((now - atMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function ProvenanceGutter({ line, now }: { line: RoadmapChecklistItemNode; now: number }) {
  if (!line.author) return <div className="rdv-gutter" />;
  const isHuman = line.claimedByHuman;
  return (
    <div className="rdv-gutter" title={line.blameSha ? `commit ${line.blameSha.slice(0, 8)}` : undefined}>
      <span className={"rdv-gutter-author" + (isHuman ? " rdv-human" : " rdv-machine")}>
        {isHuman ? "you" : line.author}
      </span>
      {line.addedAt != null && <span className="rdv-gutter-age mono">{fmtAge(line.addedAt, now)}</span>}
    </div>
  );
}

// ─── one roadmap-line card ───────────────────────────────────────────────
function RoadmapLineCard({
  line,
  now,
  linkBase,
  canClaim,
  onClaim,
  onRevert,
}: {
  line: RoadmapChecklistItemNode;
  now: number;
  linkBase: string | undefined;
  canClaim: boolean;
  onClaim: (lineId: string) => Promise<void>;
  onRevert: (lineId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"claim" | "revert" | null>(null);
  const agentAdded = !!line.author && !line.claimedByHuman;
  const stateCls = line.state === "done" ? "rdv-line-done" : line.state === "in_progress" ? "rdv-line-inflight" : "rdv-line-todo";

  return (
    <div className={"rdv-row"}>
      <ProvenanceGutter line={line} now={now} />
      <div className={"rdv-line " + stateCls + (agentAdded ? " rdv-line-agent" : "")}>
        <div className="rdv-line-head">
          {line.state === "done" ? (
            <span className="rdv-check rdv-check-done" aria-hidden="true">✓</span>
          ) : (
            <span className="rdv-check" aria-hidden="true" />
          )}
          <span className={"rdv-line-title" + (line.state === "done" ? " rdv-strike" : "")}>
            {inline(line.text, `rdv-${line.id}`, linkBase)}
          </span>
          {line.state === "done" && <span className="rdv-badge rdv-badge-done">DONE</span>}
          {line.state === "in_progress" && <span className="rdv-badge rdv-badge-inflight">IN PROGRESS</span>}
        </div>

        {line.taskIds.length > 0 && (
          <div className="rdv-chips">
            {line.taskIds.map((tid) => (
              <span key={tid} className="rdv-chip mono">{tid}</span>
            ))}
          </div>
        )}

        {line.acceptanceCriteria && (
          <>
            <div className="rdv-ac">{line.acceptanceCriteria}</div>
            <div className="rdv-dashed" />
          </>
        )}

        {agentAdded && canClaim && (
          <div className="rdv-agent-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy != null}
              onClick={async () => { setBusy("claim"); try { await onClaim(line.id); } finally { setBusy(null); } }}
            >
              {busy === "claim" ? "Claiming…" : "Keep · Claim as mine"}
            </button>
            {line.blameSha && (
              <button
                className="btn btn-ghost btn-sm rdv-danger"
                disabled={busy != null}
                onClick={async () => { setBusy("revert"); try { await onRevert(line.id); } finally { setBusy(null); } }}
              >
                {busy === "revert" ? "Reverting…" : "Revert the commit"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── section (heading + intent + its lines) ──────────────────────────────
function RoadmapSectionBlock({
  section,
  index,
  now,
  linkBase,
  canClaim,
  onClaim,
  onRevert,
}: {
  section: RoadmapSectionView;
  index: number;
  now: number;
  linkBase: string | undefined;
  canClaim: boolean;
  onClaim: (lineId: string) => Promise<void>;
  onRevert: (lineId: string) => Promise<void>;
}) {
  return (
    <section className="rdv-section">
      {section.headingText != null && (
        <h2 className="rdv-section-h">{inline(section.headingText, `rdv-h-${index}`, linkBase)}</h2>
      )}
      {section.intent && <p className="rdv-section-intent">{inline(section.intent, `rdv-intent-${index}`, linkBase)}</p>}
      {section.lines.map((line) => (
        <RoadmapLineCard key={line.id} line={line} now={now} linkBase={linkBase} canClaim={canClaim} onClaim={onClaim} onRevert={onRevert} />
      ))}
    </section>
  );
}

// ─── machine-managed block ────────────────────────────────────────────────
// A fenced code block in the doc — the closest thing to "generated, not
// hand-edited" ROADMAP.md's markdown convention has room for (see
// roadmap-view.ts's own doc comment). Collapse state remembered per browser
// profile (localStorage — see this file's own header for why: no
// server-side per-operator preference store exists anywhere in this app).
const MACHINE_BLOCK_COLLAPSE_KEY = "skynet:roadmap-machine-block-collapsed";

function MachineBlock({ block }: { block: ReturnType<typeof machineBlocks>[number] }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`${MACHINE_BLOCK_COLLAPSE_KEY}:${block.index}`) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(`${MACHINE_BLOCK_COLLAPSE_KEY}:${block.index}`, next ? "1" : "0"); } catch { /* private-browsing etc. */ }
      return next;
    });
  };
  return (
    <div className="rdv-mblock">
      <button className="rdv-mblock-head" onClick={toggle} aria-expanded={!collapsed}>
        <span className="rdv-mblock-caret" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span className="rdv-mblock-label">{block.lang ? `machine-managed · ${block.lang}` : "machine-managed"}</span>
      </button>
      {!collapsed && (
        <pre className="rdv-mblock-body mono">
          {block.lines.map((line, i) => {
            const kind = classifyMachineLine(line);
            const cls = kind === "comment" ? "rdv-mm-comment" : kind === "plain" ? "" : `rdv-mm-${kind}`;
            return (
              <div key={i} className={cls || undefined}>
                {line || " "}
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

// ─── right rail ────────────────────────────────────────────────────────────
function OwnershipRail() {
  return (
    <div className="rdv-rail-card">
      <div className="rdv-rail-title">Who may write what</div>
      <div className="rdv-own-row">
        <span className="rdv-own-who rdv-machine">Agents</span>
        <span className="rdv-own-what">May propose a change to any section. Can't delete a line or move a promised date without your approval; can't open a second competing proposal on a section that already has one open.</span>
      </div>
      <div className="rdv-own-row">
        <span className="rdv-own-who rdv-human">You</span>
        <span className="rdv-own-what">May edit the doc directly (Source mode) — your commit always wins over a stale open proposal. May approve/apply any open proposal, claim an agent-added line, or revert its commit.</span>
      </div>
      <div className="rdv-own-row">
        <span className="rdv-own-who rdv-machine">Autonomy</span>
        <span className="rdv-own-what">May auto-apply a proposal only on a fully-unattended project, and only when it doesn't delete a line or move a promised date — that always needs you.</span>
      </div>
    </div>
  );
}

function ProposedEditsRail({
  proposals,
  onApply,
}: {
  proposals: RoadmapProposal[];
  onApply: (id: string) => void;
}) {
  const open = proposals.filter((p) => p.state === "open" || p.state === "held_conflict");
  return (
    <div className="rdv-rail-card">
      <div className="rdv-rail-title">Proposed edits</div>
      {open.length === 0 ? (
        <div className="rdv-rail-empty">No open proposals.</div>
      ) : (
        <div className="rdv-proposal-list">
          {open.map((p) => (
            <div key={p.id} className={"rdv-proposal" + (p.state === "held_conflict" ? " rdv-proposal-held" : "")}>
              <div className="rdv-proposal-head">
                <span className="rdv-proposal-section mono">{p.section}</span>
                {p.state === "held_conflict" && <span className="rdv-proposal-flag">conflict — held</span>}
              </div>
              <div className="rdv-proposal-headline">{p.headline}</div>
              {p.reasoning && <div className="rdv-proposal-reason">{p.reasoning}</div>}
              <button className="btn btn-sm btn-primary" disabled={p.state === "held_conflict"} onClick={() => onApply(p.id)}>
                Apply
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentCommitsRail({ history, project }: { history: RoadmapHistoryEntry[]; project: Project }) {
  return (
    <div className="rdv-rail-card">
      <div className="rdv-rail-title">Recent commits to this file</div>
      {history.length === 0 ? (
        <div className="rdv-rail-empty">{project.repoPath ? "No commits yet." : "Needs a local checkout to show commit history."}</div>
      ) : (
        <div className="rdv-commit-list">
          {history.slice(0, 6).map((c) => (
            <div key={c.sha} className="rdv-commit-row">
              <span className="rdv-commit-subject">{c.subject}</span>
              <div className="rdv-commit-meta mono">
                <span>{c.authorName}</span>
                <span className="rdv-sep">·</span>
                <span>{fmtAge(c.at, Date.now())} ago</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RENDERED mode ─────────────────────────────────────────────────────────
function RoadmapRendered({
  project,
  doc,
  proposals,
  history,
  onOpenHistory,
  onDocRefresh,
}: {
  project: Project;
  doc: RoadmapDoc;
  proposals: RoadmapProposal[];
  history: RoadmapHistoryEntry[];
  onOpenHistory: () => void;
  onDocRefresh: () => void;
}) {
  void onOpenHistory;
  const linkBase = project.repo ? `https://github.com/${project.repo}/blob/${project.baseBranch || "main"}/` : undefined;
  const now = Date.now();
  const sections = useMemo(() => groupRoadmapSections(doc.ast), [doc.ast]);
  const blocks = useMemo(() => machineBlocks(doc.ast), [doc.ast]);

  const claim = async (lineId: string) => {
    await api.claimRoadmapLine(project.id, lineId).catch(() => undefined);
    onDocRefresh();
  };
  const revert = async (lineId: string) => {
    await api.revertRoadmapLine(project.id, lineId).catch(() => undefined);
    onDocRefresh();
  };
  const applyProposal = async (proposalId: string) => {
    await api.applyRoadmapProposal(project.id, proposalId).catch(() => undefined);
    onDocRefresh();
  };

  return (
    <div className="rdv-body">
      <div className="rdv-main">
        {sections.map((s, i) => (
          <RoadmapSectionBlock key={i} section={s} index={i} now={now} linkBase={linkBase} canClaim onClaim={claim} onRevert={revert} />
        ))}
        {blocks.map((b) => <MachineBlock key={b.index} block={b} />)}
      </div>
      <div className="rdv-rail">
        <OwnershipRail />
        <ProposedEditsRail proposals={proposals} onApply={applyProposal} />
        <RecentCommitsRail history={history} project={project} />
      </div>
    </div>
  );
}

// ─── SOURCE mode ───────────────────────────────────────────────────────────
function RoadmapSource({
  project,
  doc,
  onSaved,
}: {
  project: Project;
  doc: Extract<api.ProjectRoadmapResult, { state: "ok" }>;
  onSaved: () => void;
}) {
  const [text, setText] = useState(doc.content);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = text !== doc.content;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.commitProjectRoadmap(project.id, {
        path: doc.path,
        content: text,
        baselineHash: await sha256Hex(doc.content),
        baselineSha: doc.sha,
      });
      window.dispatchEvent(new CustomEvent("skynet:roadmap-updated", { detail: { projectId: project.id } }));
      onSaved();
    } catch (e) {
      const msg = (e as Error)?.message || "Couldn't save — try again.";
      setErr(/changed since|sha mismatch|conflict/i.test(msg) ? "Someone else changed this file since you started editing — refresh and reapply your changes." : msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rdv-source">
      <textarea
        className="rdv-source-textarea mono"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="rdv-source-bar">
        {err && <span className="rdv-source-err">{err}</span>}
        <span className="rdv-source-hint">{dirty ? "unsaved changes" : "no changes"}</span>
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save & commit"}
        </button>
      </div>
    </div>
  );
}

/** The server does the REAL optimistic-concurrency check (steward/docs.ts's
 *  contentHash) — this just needs to produce the SAME hash algorithm so a
 *  round-trip (no other edit landed) matches. SHA-256 over the raw text,
 *  hex-encoded, via the browser's native SubtleCrypto (no dependency). */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── HISTORY mode ──────────────────────────────────────────────────────────
function RoadmapHistoryView({ history, loading }: { history: RoadmapHistoryEntry[]; loading: boolean }) {
  if (loading) return <div className="kb-empty">Loading history…</div>;
  if (history.length === 0) return <div className="kb-empty">No commit history for this file (or it needs a local checkout to read git log).</div>;
  return (
    <div className="rdv-history">
      {history.map((c) => (
        <article key={c.sha} className="audit-row rdv-history-row">
          <div className="audit-row-head">
            <span className="audit-action" style={{ color: "var(--ak-text-secondary)", borderColor: "var(--ak-border)" }}>
              COMMIT
            </span>
            <span className="rdv-history-sha mono">{c.sha.slice(0, 8)}</span>
            <span className="audit-when">{fmtAge(c.at, Date.now())} ago</span>
          </div>
          <h3 className="audit-title">{c.subject}</h3>
          <div className="audit-meta mono">
            <span>{c.authorName}</span>
            <span className="audit-sep">·</span>
            <span>{c.authorEmail}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

// ─── shell: mode switch + data orchestration ──────────────────────────────
export function RoadmapDocView({ project, tasks }: { project: Project; tasks: Task[] }) {
  const [mode, setMode] = useState<RoadmapMode>("rendered");
  const [raw, setRaw] = useState<api.ProjectRoadmapResult | null>(null); // null = loading
  const [doc, setDoc] = useState<RoadmapDoc | null>(null);
  const [proposals, setProposals] = useState<RoadmapProposal[]>([]);
  const [history, setHistory] = useState<RoadmapHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .fetchProjectRoadmap(project.id)
      .then((r) => live && setRaw(r))
      .catch((e: unknown) => live && setRaw({ state: "github_error", message: (e as Error)?.message || "network error" }));
    return () => {
      live = false;
    };
  }, [project.id, nonce]);

  useEffect(() => {
    if (!raw || raw.state !== "ok") return;
    let live = true;
    Promise.all([api.fetchProjectRoadmapDoc(project.id), api.fetchRoadmapProposals(project.id)])
      .then(([d, p]) => { if (live) { setDoc(d); setProposals(p); } })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [project.id, raw, nonce]);

  useEffect(() => {
    if (mode !== "history" && history.length > 0) return; // already have a light slice for the rail
    let live = true;
    setHistoryLoading(mode === "history");
    api
      .fetchRoadmapHistory(project.id, { limit: mode === "history" ? 50 : 6 })
      .then((h) => { if (live) setHistory(h); })
      .catch(() => undefined)
      .finally(() => { if (live) setHistoryLoading(false); });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on mode switch or an explicit refresh, not on every history state change
  }, [project.id, mode, nonce]);

  // Steward's confirm-first edit commits, then dispatches this so an open tab
  // reflects the change immediately without a manual refresh.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (detail?.projectId === project.id) setNonce((n) => n + 1);
    };
    window.addEventListener("skynet:roadmap-updated", onUpdated);
    return () => window.removeEventListener("skynet:roadmap-updated", onUpdated);
  }, [project.id]);

  if (raw === null) return <div className="kb-empty">Loading roadmap…</div>;
  if (raw.state !== "ok") return <RoadmapEmptyState result={raw} project={project} onRetry={() => setNonce((n) => n + 1)} />;

  const refresh = () => setNonce((n) => n + 1);

  return (
    <div className="rdv">
      <div className="rdv-topbar">
        <div className="prd-source mono">
          synced from {raw.path} · {raw.source === "local" ? "local checkout" : "GitHub"}
        </div>
        <div className="lens-switch rdv-modeswitch">
          {(["rendered", "source", "history", "drift"] as const).map((m) => (
            <button key={m} className={"lens-btn" + (mode === m ? " on" : "")} onClick={() => setMode(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {mode === "rendered" &&
        (doc ? (
          <RoadmapRendered project={project} doc={doc} proposals={proposals} history={history} onOpenHistory={() => setMode("history")} onDocRefresh={refresh} />
        ) : (
          <div className="kb-empty">Loading roadmap…</div>
        ))}
      {mode === "source" && <RoadmapSource project={project} doc={raw} onSaved={refresh} />}
      {mode === "history" && <RoadmapHistoryView history={history} loading={historyLoading} />}
      {mode === "drift" &&
        (doc ? <RoadmapDrift project={project} doc={doc} tasks={tasks} /> : <div className="kb-empty">Loading roadmap…</div>)}
    </div>
  );
}
