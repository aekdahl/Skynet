import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditRecord, ResolveAction } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtWait, KIND_META } from "../lib/derive";
import { RiskChip } from "../components/hitl-context";
import { DiffView } from "../components/diff-view";
import * as api from "../lib/client";

// Decision audit trail (W8). The resolved-HITL history lives in its own
// append-only table, not the snapshot/WS stream, so this view fetches it
// directly and re-pulls whenever a resolution lands (resolved-count changes) or
// an audit.* delta bumps the store's auditRev (archive/delete from any tab).

// A just-resolved decision is mirrored from the live queue (see `merged`) to
// close DEF-001, but the queue is never pruned — so a *deleted* record whose
// HITL still sits in the queue would otherwise be resurrected. Only mirror
// genuinely-recent resolutions: recordAudit is synchronous with resolve, so an
// older resolution absent from the fetched trail was deleted, not merely
// in-flight, and must stay gone.
const RECENT_MS = 15_000;

const ACTION_META: Record<ResolveAction, { label: string; color: string }> = {
  approve: { label: "APPROVED", color: "var(--ok)" },
  reject: { label: "REJECTED", color: "var(--danger)" },
  modify: { label: "MODIFIED", color: "var(--info)" },
  option: { label: "PICKED OPTION", color: "var(--violet)" },
  reassign: { label: "REASSIGNED", color: "var(--violet)" },
};

const isResolveAction = (a: string): a is ResolveAction =>
  a === "approve" || a === "reject" || a === "modify" || a === "option";

// hub.resolveHitl snapshots the gate into payload so the audit is
// self-contained (the live queue item is gone once resolved). Narrow defensively.
function payloadOf(p: unknown): {
  optionIndex: number | null;
  guidance: string | null;
  kind: string | null;
  title: string | null;
  why: string | null;
  command: string | null;
  rationale: string | null;
  risk: string | null;
  options: string[] | null;
  files: string[] | null;
  patch: string | null;
  diff: { add: number; del: number } | null;
  output: string | null;
} {
  const o = (p ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const strArr = (v: unknown) =>
    Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : null;
  const d = o.diff as Record<string, unknown> | null | undefined;
  return {
    optionIndex: typeof o.optionIndex === "number" ? o.optionIndex : null,
    guidance: str(o.guidance),
    kind: str(o.kind),
    title: str(o.title),
    why: str(o.why),
    command: str(o.command),
    rationale: str(o.rationale),
    risk: str(o.risk),
    options: strArr(o.options),
    files: strArr(o.files),
    patch: str(o.patch),
    diff: d && typeof d === "object" ? { add: Number(d.add) || 0, del: Number(d.del) || 0 } : null,
    output: str(o.output),
  };
}

function fmtClockTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function AuditRow({
  rec,
  now,
  onOpenTask,
  onArchive,
  onDelete,
  confirming,
  onConfirmDelete,
  onCancelDelete,
}: {
  rec: AuditRecord;
  now: number;
  onOpenTask: (id: string) => void;
  onArchive: (hitlId: string, archived: boolean) => void;
  onDelete: (hitlId: string) => void;
  confirming: boolean;
  onConfirmDelete: (hitlId: string) => void;
  onCancelDelete: () => void;
}) {
  const { queue, runs } = useStore();
  const agent = runs.find((a) => a.id === rec.runId);
  const agentName = agent?.name ?? rec.runId;
  const meta = isResolveAction(rec.action)
    ? ACTION_META[rec.action]
    : { label: rec.action.toUpperCase(), color: "var(--muted)" };
  // Read from the persisted snapshot; fall back to the live item for older records.
  const item = queue.find((q) => q.id === rec.hitlId);
  const p = payloadOf(rec.payload);
  const kind = p.kind ?? item?.kind ?? null;
  const kindMeta = kind ? (KIND_META as Record<string, { label: string; color: string }>)[kind] : null;
  const title = p.title ?? item?.title ?? null;
  const why = p.why ?? item?.why ?? null;
  const command = p.command ?? item?.command ?? null;
  const output = p.output ?? item?.output ?? null;
  const rationale = p.rationale ?? item?.rationale ?? null;
  const risk = p.risk ?? item?.risk ?? null;
  // Read the chosen option from the SNAPSHOT (self-contained) — the live item's
  // options are gone once it leaves the queue; fall back to it for old records.
  const chosen =
    p.optionIndex != null ? (p.options?.[p.optionIndex] ?? item?.options?.[p.optionIndex] ?? null) : null;

  return (
    <article className={`audit-row${rec.archived ? " audit-row-archived" : ""}`}>
      <div className="audit-row-head">
        <span
          className="audit-action"
          style={{ color: meta.color, borderColor: meta.color }}
        >
          {meta.label}
        </span>
        {kindMeta && (
          <span
            className="kind-chip"
            style={{ color: kindMeta.color, borderColor: kindMeta.color }}
          >
            {kindMeta.label}
          </span>
        )}
        {risk && <RiskChip risk={risk as "low" | "medium" | "high"} />}
        <button className="audit-agent" onClick={() => onOpenTask(rec.runId)}>
          {agentName}
        </button>
        <span className="audit-when" title={fmtClockTime(rec.at)}>
          {fmtWait((now - rec.at) / 1000)} ago
        </span>
      </div>

      {title && <h3 className="audit-title">{title}</h3>}
      {rationale && <p className="audit-reason">💭 {rationale}</p>}
      {why && <p className="audit-why">{why}</p>}
      {command && <pre className="audit-cmd mono">{command}</pre>}
      {output && <pre className="audit-cmd mono">{output}</pre>}

      {(kind === "diff" || kind === "merge" || kind === "verifier") && p.patch && (
        <div className="audit-diff-wrap">
          {p.files && p.files.length > 0 && (
            <p className="audit-files mono">{p.files.join("  ·  ")}</p>
          )}
          <DiffView
            patch={p.patch}
            files={p.files ?? []}
            add={p.diff?.add ?? 0}
            del={p.diff?.del ?? 0}
          />
        </div>
      )}

      <div className="audit-meta mono">
        <span className="audit-op">{rec.operatorId}</span>
        <span className="audit-sep">·</span>
        <span>{fmtClockTime(rec.at)}</span>
      </div>

      {chosen && <p className="audit-detail">Chose “{chosen}”.</p>}
      {p.guidance && (
        <p className="audit-detail audit-guidance">“{p.guidance}”</p>
      )}

      <div className="audit-actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onArchive(rec.hitlId, !rec.archived)}
          title={rec.archived ? "Restore to the trail" : "Archive — hide from the trail (kept in history)"}
        >
          {rec.archived ? "⊕ Restore" : "⊘ Archive"}
        </button>
        {confirming ? (
          <span className="del-confirm">
            Delete decision?{" "}
            <button className="btn btn-danger btn-sm" onClick={() => onDelete(rec.hitlId)}>
              Yes, delete
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onCancelDelete}>
              No
            </button>
          </span>
        ) : (
          <button
            className="btn btn-ghost btn-sm audit-del"
            onClick={() => onConfirmDelete(rec.hitlId)}
            title="Permanently delete this decision"
          >
            Delete
          </button>
        )}
      </div>
    </article>
  );
}

export function AuditView({
  now,
  onOpenTask,
}: {
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const { queue, auditRev, archiveAudit, deleteAudit, archiveAllAudit, clearAudit } = useStore();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // hitlIds removed this session. records won't include them after the re-fetch,
  // but a recently-resolved decision may still sit in the never-pruned queue, so
  // suppress it in `merged` until its resolution ages past the recency window.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());

  // Re-fetch whenever a resolution lands (the store's resolved tally moves) or
  // an audit.* delta bumps auditRev (archive/delete/clear, incl. other tabs).
  const resolvedCount = useMemo(
    () => queue.filter((q) => q.resolvedAt != null).length,
    [queue],
  );

  const load = useCallback(async () => {
    try {
      setRecords(await api.fetchAudit());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, resolvedCount, auditRev]);

  // Merge the fetched history with decisions resolved live in this session
  // (kept current by the WS stream). This closes DEF-001: a just-resolved
  // decision is in the store queue the instant its `hitl.resolved` event lands
  // — before/independent of the /api/audit fetch — so the trail never shows a
  // stale gap while the mount-fetch is in flight. Deduped by hitlId, newest first.
  const merged = useMemo<AuditRecord[]>(() => {
    const byId = new Map<string, AuditRecord>();
    for (const r of records ?? []) {
      if (removed.has(r.hitlId)) continue;
      byId.set(r.hitlId, r);
    }
    for (const q of queue) {
      if (q.resolvedAt == null || !q.resolution || removed.has(q.id) || byId.has(q.id)) continue;
      if (now - q.resolvedAt > RECENT_MS) continue; // older + absent = deleted, don't resurrect
      byId.set(q.id, {
        workspaceId: q.workspaceId,
        hitlId: q.id,
        runId: q.runId,
        action: q.resolution.action,
        operatorId: q.resolution.by,
        at: q.resolvedAt,
        archived: false,
        payload: {
          optionIndex: q.resolution.optionIndex,
          guidance: q.resolution.guidance,
          kind: q.kind,
          title: q.title,
          why: q.why,
          command: q.command,
          rationale: q.rationale,
          risk: q.risk,
          options: q.options,
          recommended: q.recommended,
          diff: q.diff,
        },
      });
    }
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }, [records, queue, removed, now]);

  const active = useMemo(() => merged.filter((r) => !r.archived), [merged]);
  const archived = useMemo(() => merged.filter((r) => r.archived), [merged]);

  const onArchive = useCallback(
    async (hitlId: string, next: boolean) => {
      await archiveAudit(hitlId, next);
      await load();
    },
    [archiveAudit, load],
  );
  const onDelete = useCallback(
    async (hitlId: string) => {
      setConfirmDelete(null);
      setRemoved((s) => new Set(s).add(hitlId));
      await deleteAudit(hitlId);
      await load();
    },
    [deleteAudit, load],
  );
  const onArchiveAll = useCallback(async () => {
    await archiveAllAudit();
    await load();
  }, [archiveAllAudit, load]);
  const onClear = useCallback(async () => {
    setConfirmClear(false);
    setRemoved(new Set(merged.map((r) => r.hitlId)));
    await clearAudit();
    await load();
  }, [clearAudit, load, merged]);

  const rowProps = (rec: AuditRecord) => ({
    rec,
    now,
    onOpenTask,
    onArchive,
    onDelete,
    confirming: confirmDelete === rec.hitlId,
    onConfirmDelete: setConfirmDelete,
    onCancelDelete: () => setConfirmDelete(null),
  });

  return (
    <section className="audit">
      <div className="vw-head audit-head">
        <div>
          <h1>Decision audit</h1>
          <p>
            Every resolved human-in-the-loop decision in this workspace — who
            decided what, when, and how.
          </p>
        </div>
        {merged.length > 0 && (
          <div className="audit-bulk">
            {active.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => void onArchiveAll()}>
                ⊘ Archive all
              </button>
            )}
            {confirmClear ? (
              <span className="del-confirm">
                Clear the entire trail?{" "}
                <button className="btn btn-danger btn-sm" onClick={() => void onClear()}>
                  Yes, clear
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(false)}>
                  No
                </button>
              </span>
            ) : (
              <button
                className="btn btn-ghost btn-sm audit-del"
                onClick={() => setConfirmClear(true)}
              >
                Clear trail
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="audit-empty">
          <p>Couldn’t load the audit trail.</p>
          <button className="btn btn-ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!error && records != null && merged.length === 0 && (
        <div className="audit-empty">
          <span className="audit-empty-mark">⊙</span>
          <p>No decisions resolved yet — the trail fills as you clear the Inbox.</p>
        </div>
      )}

      {!error && active.length > 0 && (
        <div className="audit-list">
          {active.map((rec, i) => (
            <AuditRow key={`${rec.hitlId}-${rec.at}-${i}`} {...rowProps(rec)} />
          ))}
        </div>
      )}

      {!error && archived.length > 0 && (
        <div className="kb-archive-sec">
          <button
            className="kb-archive-head"
            onClick={() => setShowArchived((s) => !s)}
            aria-expanded={showArchived}
          >
            {showArchived ? "▾" : "▸"} ARCHIVED · {archived.length}
          </button>
          {showArchived && (
            <div className="audit-list">
              {archived.map((rec, i) => (
                <AuditRow key={`${rec.hitlId}-${rec.at}-${i}`} {...rowProps(rec)} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
