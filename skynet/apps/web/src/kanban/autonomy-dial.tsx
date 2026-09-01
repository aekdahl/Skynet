// ─── Autonomy dial (TASK 19) ────────────────────────────────────────────────
// A dial, not a switch: the 4-detent composite read over Project.autonomy +
// Project.approvalLevel (see @skynet/shared's autonomy.ts, the single source
// of truth for the notch + gating both this component and the server derive
// from), plus the persisted circuit-breaker/override panel — the breaker
// existed before this (orchestrator.ts's old in-memory autonomyStreaks Map)
// but was invisible anywhere in the product; this is its first UI.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutonomyDetent, AutonomyDetentState, Project } from "@skynet/shared";
import { AUTONOMY_DETENTS, AUTONOMY_DETENT_INFO, autonomyGateRows, fieldsForDetent } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { useConfirm } from "../components/confirm";

const INDEX_OF: Record<AutonomyDetent, number> = { shadow: 0, assisted: 1, earned: 2, unattended: 3 };

function fmtWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AutonomyDialButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Autonomy dial
      </button>
      {open && <AutonomyDial project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

function AutonomyDial({ project, onClose }: { project: Project; onClose: () => void }) {
  const { setAutonomyDetent, createAutonomyOverride, autonomyRev } = useStore();
  const confirm = useConfirm();
  const [state, setState] = useState<AutonomyDetentState | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // A raise (moving to a HIGHER notch) stages here instead of applying
  // immediately — the typed-confirmation dialog below is what actually commits
  // it. Lowering (or staying put) applies straight through, same as the old
  // approvalLevel dropdown already did for every level except "full".
  const [raiseTarget, setRaiseTarget] = useState<AutonomyDetent | null>(null);
  const [raiseTyped, setRaiseTyped] = useState("");
  const [showEntries, setShowEntries] = useState(false);
  const dragging = useRef(false);
  const suppressClick = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getAutonomyDetent(project.id));
      setError(false);
    } catch {
      setError(true);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load, autonomyRev]);

  const committed = state?.detent ?? null;

  const applyDetent = useCallback(
    async (detent: AutonomyDetent) => {
      setBusy(true);
      try {
        await setAutonomyDetent(project.id, detent);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [project.id, setAutonomyDetent, load],
  );

  const requestDetent = useCallback(
    (target: AutonomyDetent) => {
      if (!committed || target === committed || busy) return;
      if (INDEX_OF[target] > INDEX_OF[committed]) {
        setRaiseTarget(target);
        setRaiseTyped("");
      } else {
        void applyDetent(target);
      }
    },
    [committed, busy, applyDetent],
  );

  const nearestStopFromClientX = (clientX: number): AutonomyDetent => {
    const el = trackRef.current;
    if (!el) return committed ?? "shadow";
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.round(frac * 3);
    return AUTONOMY_DETENTS[idx]!;
  };

  const onTrackKeyDown = (e: React.KeyboardEvent) => {
    if (!committed) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const idx = Math.min(3, INDEX_OF[committed] + 1);
      requestDetent(AUTONOMY_DETENTS[idx]!);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const idx = Math.max(0, INDEX_OF[committed] - 1);
      requestDetent(AUTONOMY_DETENTS[idx]!);
    }
  };

  // Preview state: whichever detent is being previewed while dragging (falls
  // back to the committed value) — this is what the gate grid live-derives
  // from, so a drag shows its consequence before release commits it.
  const [previewDetent, setPreviewDetent] = useState<AutonomyDetent | null>(null);
  const effectiveDetent = previewDetent ?? committed;

  const onThumbPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPreviewDetent(nearestStopFromClientX(e.clientX));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    suppressClick.current = true; // the pointerup below is immediately followed by a click on the same target — consume it once
    const target = nearestStopFromClientX(e.clientX);
    setPreviewDetent(null);
    requestDetent(target);
  };
  const onTrackClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false; // the drag-release above already acted on this same position
      return;
    }
    requestDetent(nearestStopFromClientX(e.clientX));
  };

  const gateRows = state && effectiveDetent ? autonomyGateRows(gateFieldsFor(effectiveDetent, state)) : [];

  const confirmRaise = async () => {
    if (!raiseTarget) return;
    const label = AUTONOMY_DETENT_INFO[raiseTarget].name;
    if (raiseTyped.trim().toUpperCase() !== label.toUpperCase()) return;
    const target = raiseTarget;
    setRaiseTarget(null);
    await applyDetent(target);
  };

  // What's newly un-gated by this specific raise, for the typed-confirmation
  // dialog's "this stops needing a person for" list — the rows that flip from
  // gated to open going from the CURRENT notch to the target one.
  const raiseNewlyOpen =
    raiseTarget && committed && state
      ? autonomyGateRows(gateFieldsFor(raiseTarget, state)).filter(
          (row, i) => row.gated === false && autonomyGateRows(gateFieldsFor(committed, state))[i]?.gated === true,
        )
      : [];

  const breaker = state?.breaker ?? null;
  const override = state?.override ?? null;
  const max = state?.maxConsecutiveFailures ?? 0;
  const tripped = !!breaker?.trippedAt;

  const onOverride = async () => {
    if (
      !(await confirm({
        title: "Bypass the breaker?",
        body: "Autonomy resumes immediately. It reverts on its own in a couple hours unless you re-enable it for good before then.",
        confirmLabel: "Override — I'll watch it",
      }))
    )
      return;
    setBusy(true);
    try {
      await createAutonomyOverride(project.id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ad-backdrop" onMouseDown={onClose}>
      <div className="ad-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ad-header">
          <div>
            <h2 className="ad-title">Autonomy — {project.name}</h2>
            <p className="ad-subtitle">A dial, not a switch — pick how much runs without a person.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <p className="ad-subtitle">Couldn't load — try again.</p>}
        {!state && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="ak-skel-row" style={{ width: "100%" }} />
            <div className="ak-skel-row" style={{ width: "80%" }} />
          </div>
        )}

        {state && (
          <>
            <div className="ad-cards">
              {AUTONOMY_DETENTS.map((d) => {
                const info = AUTONOMY_DETENT_INFO[d];
                const isCurrent = d === committed;
                return (
                  <button
                    type="button"
                    key={d}
                    className={"ad-card" + (isCurrent ? " ad-card-current" : "")}
                    onClick={() => requestDetent(d)}
                    disabled={busy}
                  >
                    <span className="ad-card-index">{String(info.index).padStart(2, "0")}</span>
                    <span className="ad-card-name">
                      {info.name}
                      {isCurrent && <span className="ad-card-suffix">— CURRENT</span>}
                    </span>
                    <span className="ad-card-consequence">{info.consequence}</span>
                  </button>
                );
              })}
            </div>

            <div
              ref={trackRef}
              className="ad-track"
              role="slider"
              tabIndex={0}
              aria-label="Autonomy notch"
              aria-valuemin={1}
              aria-valuemax={4}
              aria-valuenow={committed ? INDEX_OF[committed] + 1 : 1}
              aria-valuetext={committed ? AUTONOMY_DETENT_INFO[committed].name : undefined}
              onKeyDown={onTrackKeyDown}
              onClick={onTrackClick}
              onPointerMove={onTrackPointerMove}
              onPointerUp={endDrag}
            >
              <div
                className="ad-track-fill"
                style={{ width: `${(INDEX_OF[effectiveDetent ?? "shadow"] / 3) * 100}%` }}
              />
              {AUTONOMY_DETENTS.map((d, i) => (
                <span key={d} className="ad-track-stop" style={{ left: `${(i / 3) * 100}%` }} />
              ))}
              <div
                className="ad-track-thumb"
                style={{ left: `${(INDEX_OF[effectiveDetent ?? "shadow"] / 3) * 100}%` }}
                onPointerDown={onThumbPointerDown}
              />
            </div>

            <div>
              <p className="ad-gates-title">At this notch, a person is required for</p>
              <div className="ad-gates-grid">
                {gateRows.map((row) => (
                  <div key={row.key} className={"ad-gate-row " + (row.gated ? "ad-gate-row-gated" : "ad-gate-row-open")}>
                    <span className="ad-gate-dot" aria-hidden="true" />
                    {row.label}
                  </div>
                ))}
              </div>
            </div>

            <div className="ad-breaker">
              <div className="ad-breaker-head">
                <span className={"ad-breaker-dot" + (tripped || (breaker?.count ?? 0) > 0 ? " ak-pulse-dot" : "")} aria-hidden="true" />
                <span className="ad-breaker-title">Autonomy breaker</span>
              </div>
              <p className="ad-breaker-sentence">
                {max <= 0
                  ? "Disabled on this server — nothing trips it."
                  : tripped
                    ? `Tripped ${breaker!.trippedAt ? fmtWhen(breaker!.trippedAt) : ""} — ${breaker!.count} consecutive bad outcomes with no good one in between turned Autonomy off.`
                    : `Trips Autonomy off after ${max} consecutive bad outcomes (a flagged review or a failed run) with no good one in between — clears on the next good outcome. ${breaker?.count ?? 0}/${max} so far.`}
              </p>
              {max > 0 && (
                <div className="ad-breaker-ladder" aria-hidden="true">
                  {Array.from({ length: max }, (_, i) => (
                    <span key={i} className={"ad-breaker-block" + (i < (breaker?.count ?? 0) || tripped ? " ad-breaker-block-lit" : "")} />
                  ))}
                </div>
              )}
              {override && (
                <p className="ad-breaker-override">
                  Overridden by {override.overriddenBy} until {fmtWhen(override.expiresAt)} — reverts automatically if the breaker is still tripped then.
                </p>
              )}
              {(breaker?.entries.length ?? 0) > 0 && (
                <div className="ad-breaker-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowEntries((s) => !s)}>
                    {showEntries ? "Hide" : `See the ${breaker!.entries.length} revert${breaker!.entries.length === 1 ? "" : "s"}`}
                  </button>
                  {tripped && !override && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onOverride} disabled={busy}>
                      Override — I'll watch it
                    </button>
                  )}
                </div>
              )}
              {showEntries && breaker && (
                <ul className="ad-breaker-entries">
                  {breaker.entries.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {raiseTarget && state && (
        <div className="ad-confirm-backdrop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ad-confirm-card">
            <h3 className="ad-confirm-title">Raise autonomy to {AUTONOMY_DETENT_INFO[raiseTarget].name}?</h3>
            <p className="ad-confirm-body">This stops needing a person for:</p>
            <ul className="ad-confirm-list">
              {raiseNewlyOpen.length > 0 ? raiseNewlyOpen.map((r) => <li key={r.key}>{r.label}</li>) : <li>Nothing new — this notch only changes bookkeeping.</li>}
            </ul>
            <label>
              <span className="ad-confirm-label">Type {AUTONOMY_DETENT_INFO[raiseTarget].name.toUpperCase()} to confirm</span>
              <input
                className="ad-confirm-input"
                style={{ width: "100%", marginTop: 6 }}
                value={raiseTyped}
                onChange={(e) => setRaiseTyped(e.target.value)}
                autoFocus
              />
            </label>
            <div className="ad-confirm-actions">
              <button className="btn btn-ghost" onClick={() => setRaiseTarget(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={raiseTyped.trim().toUpperCase() !== AUTONOMY_DETENT_INFO[raiseTarget].name.toUpperCase() || busy}
                onClick={confirmRaise}
              >
                Raise to {AUTONOMY_DETENT_INFO[raiseTarget].name}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** `fieldsForDetent` leaves `approvalLevel` unset for "shadow" (see its own
 *  doc comment) — fill it back in from the live state for gate-row derivation
 *  so a preview of "shadow" doesn't lose track of what level it'll resume at. */
function gateFieldsFor(detent: AutonomyDetent, state: AutonomyDetentState): { autonomy: boolean; approvalLevel: AutonomyDetentState["approvalLevel"] } {
  const fields = fieldsForDetent(detent);
  return { autonomy: fields.autonomy, approvalLevel: fields.approvalLevel ?? state.approvalLevel };
}
