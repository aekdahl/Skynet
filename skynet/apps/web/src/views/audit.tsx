import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditRecord, ResolveAction } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtWait, KIND_META } from "../lib/derive";
import * as api from "../lib/client";

// Decision audit trail (W8). The resolved-HITL history lives in its own
// append-only table, not the snapshot/WS stream, so this view fetches it
// directly and re-pulls whenever a resolution lands (resolved-count changes).

const ACTION_META: Record<ResolveAction, { label: string; color: string }> = {
  approve: { label: "APPROVED", color: "var(--ok)" },
  reject: { label: "REJECTED", color: "var(--danger)" },
  modify: { label: "MODIFIED", color: "var(--info)" },
  option: { label: "PICKED OPTION", color: "var(--violet)" },
};

const isResolveAction = (a: string): a is ResolveAction =>
  a === "approve" || a === "reject" || a === "modify" || a === "option";

// hub.resolveHitl records payload as { optionIndex, guidance } — narrow defensively.
function payloadOf(p: unknown): { optionIndex: number | null; guidance: string | null } {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    optionIndex: typeof o.optionIndex === "number" ? o.optionIndex : null,
    guidance: typeof o.guidance === "string" ? o.guidance : null,
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
  onOpenAgent,
}: {
  rec: AuditRecord;
  now: number;
  onOpenAgent: (id: string) => void;
}) {
  const { queue, agents } = useStore();
  // Enrich from live state when the item/agent are still around.
  const item = queue.find((q) => q.id === rec.hitlId);
  const agent = agents.find((a) => a.id === rec.agentId);
  const agentName = agent?.name ?? rec.agentId;
  const meta = isResolveAction(rec.action)
    ? ACTION_META[rec.action]
    : { label: rec.action.toUpperCase(), color: "var(--muted)" };
  const { optionIndex, guidance } = payloadOf(rec.payload);
  const chosen =
    optionIndex != null && item?.options ? item.options[optionIndex] : null;

  return (
    <article className="audit-row">
      <div className="audit-row-head">
        <span
          className="audit-action"
          style={{ color: meta.color, borderColor: meta.color }}
        >
          {meta.label}
        </span>
        {item && (
          <span
            className="kind-chip"
            style={{ color: KIND_META[item.kind].color, borderColor: KIND_META[item.kind].color }}
          >
            {KIND_META[item.kind].label}
          </span>
        )}
        <button className="audit-agent" onClick={() => onOpenAgent(rec.agentId)}>
          {agentName}
        </button>
        <span className="audit-when" title={fmtClockTime(rec.at)}>
          {fmtWait((now - rec.at) / 1000)} ago
        </span>
      </div>

      {item && <h3 className="audit-title">{item.title}</h3>}

      <div className="audit-meta mono">
        <span className="audit-op">{rec.operatorId}</span>
        <span className="audit-sep">·</span>
        <span>{fmtClockTime(rec.at)}</span>
      </div>

      {chosen && <p className="audit-detail">Chose “{chosen}”.</p>}
      {guidance && (
        <p className="audit-detail audit-guidance">“{guidance}”</p>
      )}
    </article>
  );
}

export function AuditView({
  now,
  onOpenAgent,
}: {
  now: number;
  onOpenAgent: (id: string) => void;
}) {
  const { queue } = useStore();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState(false);

  // Re-fetch whenever a resolution lands (the store's resolved tally moves).
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
  }, [load, resolvedCount]);

  return (
    <section className="audit">
      <div className="vw-head">
        <h1>Decision audit</h1>
        <p>
          Every resolved human-in-the-loop decision in this workspace — who
          decided what, when, and how.
        </p>
      </div>

      {error && (
        <div className="audit-empty">
          <p>Couldn’t load the audit trail.</p>
          <button className="btn btn-ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!error && records != null && records.length === 0 && (
        <div className="audit-empty">
          <span className="audit-empty-mark">⊙</span>
          <p>No decisions resolved yet — the trail fills as you clear the Inbox.</p>
        </div>
      )}

      {!error && records != null && records.length > 0 && (
        <div className="audit-list">
          {records.map((rec, i) => (
            <AuditRow
              key={`${rec.hitlId}-${rec.at}-${i}`}
              rec={rec}
              now={now}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </div>
      )}
    </section>
  );
}
