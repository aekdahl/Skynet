import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProviderId, ProviderInfo, Agent, HitlItem, SecretMeta, TaskRun } from "@skynet/shared";
import { endpointLabel, vendorForBaseUrl } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import {
  classifyRun,
  computeUsageRollup,
  fmtCost,
  fmtNum,
  providerInfo,
  providerReadiness,
  runnerIdleLabel,
  runnerName,
  STALE_HEARTBEAT_SEC,
  workersOf,
  type UsageRollup,
} from "../lib/derive";
import { PrimaryButton } from "../components/empty";
import { StatusDot } from "../components/common";
import { useConfirm } from "../components/confirm";
import { toast } from "../components/toast";

export function ConfigForm({
  initial,
  onSave,
  onCancel,
  submitLabel,
}: {
  initial?: Agent;
  onSave: (r: { name: string; provider: ProviderId; model: string; credentialId?: string | null; label: string | null }) => void;
  onCancel: () => void;
  // Overrides the submit label. Defaults by mode: editing → "Save changes",
  // new → "Add to fleet". Cloning passes its own (it creates, not edits).
  submitLabel?: string;
}) {
  const { providers, fleet } = useStore();
  // Existing labels across the fleet, offered as a datalist so operators reuse a
  // group name instead of accidentally spawning near-duplicate buckets.
  const knownLabels = Array.from(
    new Set(fleet.map((a) => a.label?.trim()).filter((l): l is string => !!l)),
  ).sort((a, b) => a.localeCompare(b));
  const isConfigured = (p: ProviderInfo) => providerReadiness(p).ready;
  const [name, setName] = useState(initial ? initial.name : "");
  // Optional grouping label — how the fleet view buckets this agent (empty →
  // "Ungrouped"). Free-form; the datalist just suggests existing groups.
  const [label, setLabel] = useState(initial?.label ?? "");
  const [provider, setProvider] = useState<ProviderId>(
    initial
      ? initial.provider
      : (providers.find(isConfigured)?.id ?? providers[0]?.id ?? "claude"),
  );
  const selected = providerInfo(providers, provider);
  const selectedReq = selected.requirements;

  // Which credential this agent authenticates with — offered when EDITING as
  // well as creating, since a credential can name a Claude-compatible endpoint
  // and is therefore how a runner moves to a cheaper vendor. undefined → the
  // provider's default key. We fetch the credential list so a provider with a
  // second ("another account") key can be picked here.
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [credentialId, setCredentialId] = useState<string | undefined>(initial?.credentialId ?? undefined);
  // A credential pointed at a Claude-compatible endpoint runs a DIFFERENT
  // vendor's models — suggesting Anthropic's ids there would send the operator
  // straight into a wrong-model run (several endpoints silently remap an
  // unknown id, so it half-works and you can't tell what actually ran).
  const credEndpoint = secrets.find((c) => c.id === credentialId)?.baseUrl ?? null;
  const credVendor = vendorForBaseUrl(credEndpoint);
  const models = credVendor ? credVendor.models.map((m) => m.id) : selected.models;
  const [model, setModel] = useState(initial ? initial.model : (models[0] ?? ""));
  // Custom-model mode: the operator typed a model id not in the suggestions —
  // e.g. one released after this catalog. Starts on when editing an agent whose
  // model isn't a known suggestion, or when a provider offers none.
  const [custom, setCustom] = useState(
    initial ? !models.includes(initial.model) : models.length === 0,
  );
  useEffect(() => {
    api.fetchSecrets().then((r) => setSecrets(r.secrets)).catch(() => setSecrets([]));
  }, []);
  const extraCreds = secrets.filter((s) => s.provider === provider && !s.isDefault);

  // Reset the model to the new provider's default when the provider CHANGES (but
  // never on first mount — that would clobber an existing agent's model).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setModel(models[0] ?? "");
    setCustom(models.length === 0);
    setCredentialId(undefined); // a new provider → back to its default key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Switching to a credential on a compatible endpoint switches WHICH VENDOR
  // serves this runner, so the model has to follow. Leaving an Anthropic id
  // selected would be worse than an error: several endpoints silently remap an
  // unknown id to some default, so the run succeeds on a model nobody chose.
  const credMounted = useRef(false);
  useEffect(() => {
    if (!credMounted.current) {
      credMounted.current = true;
      return;
    }
    setModel(models[0] ?? "");
    setCustom(models.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId]);

  return (
    <div className="cfg">
      <div className="cfg-row">
        <label className="cfg-label">Agent name</label>
        <input
          className="qx-input"
          value={name}
          placeholder="agent-10"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Group</label>
        <input
          className="qx-input"
          value={label}
          list="fleet-labels"
          placeholder="Optional — e.g. reviewers, frontend, backend"
          onChange={(e) => setLabel(e.target.value)}
        />
        <datalist id="fleet-labels">
          {knownLabels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Provider</label>
        <div className="cfg-prov">
          {providers.map((p) => {
            const rd = providerReadiness(p);
            return (
              <button
                key={p.id}
                className={"cfg-prov-btn" + (provider === p.id ? " on" : "")}
                style={
                  provider === p.id
                    ? { borderColor: p.color, color: p.color }
                    : rd.ready
                      ? undefined
                      : { opacity: 0.4, cursor: "not-allowed" }
                }
                disabled={!rd.ready}
                title={rd.ready ? undefined : `${p.name} needs ${rd.missing.join(" and ")}`}
                onClick={() => setProvider(p.id)}
              >
                <span style={{ color: p.color }}>{p.glyph}</span> {p.name}
                {!rd.ready && " · needs setup"}
              </button>
            );
          })}
        </div>
        {selectedReq && (
          <p className="cfg-prov-req">
            {selectedReq.runtime === "cli"
              ? `Runs the ${selectedReq.bin} CLI on the server — must be installed on PATH.`
              : "Runs in-process — no CLI to install."}{" "}
            {selectedReq.cliLogin
              ? "Auth via its CLI login or a key."
              : selectedReq.authEnvVars.length > 0
                ? `Auth: ${selectedReq.authEnvVars.slice(0, 3).join(" / ")}.`
                : ""}{" "}
            {selectedReq.installHint}
            {selectedReq.docsUrl && (
              <>
                {" "}
                <a href={selectedReq.docsUrl} target="_blank" rel="noreferrer">
                  Setup docs ↗
                </a>
              </>
            )}
          </p>
        )}
      </div>
      {/* Credential picker — whenever the provider has more than its default key.
          Offered when EDITING as well as creating: a credential can name a
          Claude-compatible endpoint, so this is how an existing runner moves to a
          cheaper vendor. Without it the only route was delete-and-recreate, which
          throws away the runner's task history. */}
      {extraCreds.length > 0 && (
        <div className="cfg-row">
          <label className="cfg-label">Key</label>
          <select
            className="qx-input cfg-cred-select"
            value={credentialId ?? ""}
            onChange={(e) => setCredentialId(e.target.value || undefined)}
          >
            <option value="">Default {selected.name} key</option>
            {extraCreds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || "key"} · ····{c.last4}
                {c.baseUrl ? ` · ${endpointLabel(c.baseUrl)}` : ""}
              </option>
            ))}
          </select>
          {credVendor && (
            <p className="cfg-model-note">
              This runner will talk to <b>{credVendor.name}</b>, not Anthropic — the models below are theirs.
              It keeps the full agent loop (tool gating, questions, escalations) and meters spend at their
              rates.
              {initial && " Applies to its next run; anything in flight keeps the credential it started with."}
            </p>
          )}
        </div>
      )}
      <div className="cfg-row">
        <label className="cfg-label">Model</label>
        <div className="cfg-models">
          {models.map((m) => (
            <button
              key={m}
              className={"cfg-model-btn" + (!custom && model === m ? " on" : "")}
              onClick={() => {
                setCustom(false);
                setModel(m);
              }}
            >
              {m}
            </button>
          ))}
          <button
            className={"cfg-model-btn" + (custom ? " on" : "")}
            title="Use a model that isn't listed yet — e.g. one released after this build. The provider's CLI/SDK validates it."
            onClick={() => {
              setCustom(true);
              setModel("");
            }}
          >
            + Custom…
          </button>
        </div>
        {custom && (
          <input
            className="qx-input cfg-model-custom"
            autoFocus
            placeholder="model id — e.g. claude-opus-4-9 · gpt-5.3-codex · gemini-3-ultra"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        {custom && model.trim() && !models.includes(model.trim()) && (
          <p className="cfg-model-note">
            Custom model — Skynet won’t verify this; {selected.name} accepts it or the run fails loudly.
          </p>
        )}
      </div>
      <div className="qx-row">
        <PrimaryButton
          disabled={!model.trim()}
          reason={custom ? "Enter a model id to continue." : "Pick a model to continue."}
          onClick={() => onSave({ name: name.trim(), provider, model: model.trim(), credentialId: credentialId ?? null, label: label.trim() || null })}
        >
          {submitLabel ?? (initial ? "Save changes" : "Add to fleet")}
        </PrimaryButton>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Suggest a fresh name for a cloned agent: bump a trailing number
// ("claude-agent-01" → "claude-agent-02"), else append "-copy", skipping names
// already taken so the duplicate reads as its own agent at a glance.
export function suggestCloneName(base: string, taken: Set<string>): string {
  const m = base.match(/^(.*?)(\d+)$/);
  if (m) {
    const prefix = m[1]!;
    const width = m[2]!.length;
    for (let n = parseInt(m[2]!, 10) + 1; n < 100000; n++) {
      const cand = prefix + String(n).padStart(width, "0");
      if (!taken.has(cand)) return cand;
    }
  }
  let cand = `${base}-copy`;
  for (let i = 2; taken.has(cand); i++) cand = `${base}-copy-${i}`;
  return cand;
}

/** Toast the informRuns() result — always name a real skip count rather than
 *  a blanket "sent", since a queued note is a best-effort attachment (no live
 *  session, or the runner doesn't support it, both skip honestly). */
export function toastInformResult(informedCount: number, skippedCount: number): void {
  if (informedCount === 0) {
    toast(
      skippedCount > 0
        ? `Note not delivered — ${skippedCount} agent${skippedCount === 1 ? "" : "s"} had no active session to attach it to.`
        : "Note not delivered.",
    );
    return;
  }
  toast(
    `Note queued for ${informedCount} agent${informedCount === 1 ? "" : "s"}'s next turn` +
      (skippedCount > 0 ? ` (${skippedCount} skipped — no active session)` : "") +
      ".",
    "success",
  );
}

/**
 * The `inform` note composer — shared by Fleet's multi-select and Project's
 * whole-project bulk action. Purely presentational: the caller supplies how
 * many targets are selected and what to do with the note text. No extra
 * turn/API call to the agent happens here or anywhere downstream — this just
 * collects the note and hands it to informRuns().
 */
export function InformComposer({
  count,
  countLabel,
  onSend,
  onCancel,
}: {
  /** How many runs this note would target, for the button label + empty-state. */
  count: number;
  /** Override the default "N agent(s)" wording (e.g. "this project's active agents"). */
  countLabel?: string;
  onSend: (note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const label = countLabel ?? `${count} agent${count === 1 ? "" : "s"}`;
  return (
    <div className="panel inform-panel">
      <div className="panel-head">
        📣 MASS INFORM — {label} selected
      </div>
      <p className="inform-hint">
        Attaches to each selected agent's NEXT prompt — no extra turn, no reply expected. Nothing sends until it queues.
      </p>
      <textarea
        className="qx-input inform-textarea"
        rows={3}
        autoFocus
        placeholder="e.g. Heads up — the shared auth module moved to packages/auth; update imports if you touch it."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="qx-row">
        <PrimaryButton
          disabled={!note.trim() || count === 0 || sending}
          reason={count === 0 ? "Select at least one agent first." : "Write a note to send."}
          onClick={async () => {
            setSending(true);
            try {
              await onSend(note.trim());
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? "Queuing…" : `Queue note for ${label}`}
        </PrimaryButton>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Shared per-agent action handlers, passed down to both densities so neither
// card/row duplicates the mutation logic.
interface AgentActions {
  onOpenAgent: (id: string) => void;
  onOpenTask: (id: string) => void;
  onConfigure: (r: Agent) => void;
  onDuplicate: (r: Agent) => void;
  onToggleReviewer: (r: Agent) => void;
  onRetire: (r: Agent) => void;
  // Deep-links straight to the run carrying the open gate (blocked, a real
  // decision is pending) — same navigation as opening its activity, just a
  // named, one-click affordance for the specific situation.
  onAnswer: (runId: string) => void;
  // Blocked with NO pending decision (stale heartbeat, nothing to answer) —
  // the only real remediation available today is freeing the runner so a
  // human (or the autonomy loop) can pick up fresh; see classifyRun's own
  // "stuck in X — no pending decision" branch.
  onUnstick: (r: Agent, runId: string) => void;
  // An idle agent has no live run to attach a chat message to (sendAgentMessage/
  // streamAgentMessage both operate on a RUN id) — Steward is the app's real
  // conversational surface for "what should this agent do", same event this
  // project already dispatches for a backlog task's "💬 Discuss" button.
  onMessage: (r: Agent) => void;
}

/** Of a set of already-FINISHED runs, how many actually landed a clean merge
 *  (mergedAt set, never reverted). null = no finished runs yet, rendered as
 *  "—" rather than a misleading 0%/100%. Shared by the per-agent readout
 *  (reliabilityOf) and the fleet-wide aggregate in FleetOverview. */
function computeReliability(finished: TaskRun[]): { pct: number | null; finished: number } {
  if (finished.length === 0) return { pct: null, finished: 0 };
  const clean = finished.filter((r) => r.mergedAt != null && !r.merge?.revertedAt);
  return { pct: Math.round((clean.length / finished.length) * 100), finished: finished.length };
}

/** "% merged clean" (Phase 23) — of this agent's FINISHED runs. No new
 *  collection: grouped straight from the already-loaded TaskRun list by
 *  agentId. */
function reliabilityOf(agentId: string, runs: TaskRun[]): { pct: number | null; finished: number } {
  return computeReliability(runs.filter((r) => r.agentId === agentId && r.status === "done"));
}

function ReliabilityReadout({ agentId, runs }: { agentId: string; runs: TaskRun[] }) {
  const { pct, finished } = reliabilityOf(agentId, runs);
  const title =
    pct == null
      ? "No finished runs yet"
      : `${pct}% merged clean across ${finished} finished run${finished === 1 ? "" : "s"}`;
  return (
    <span className="fleet-reliability" title={title}>
      <span className="fleet-reliability-pct mono">{pct == null ? "—" : `${pct}%`}</span>
      <span className="fleet-reliability-track">
        <span
          className={"fleet-reliability-fill" + (pct != null && pct < 50 ? " low" : "")}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
    </span>
  );
}

// "—" for genuinely no cost data (no runs, or none reported one yet) — never
// 0, which would read as a real free run. Shared by AgentCard + AgentRow so
// both densities render the exact same "$0 vs vendor doesn't report" logic.
function costOf(roll: UsageRollup | undefined): { label: string; title: string } {
  const label = roll?.costUsd != null ? fmtCost(roll.costUsd) : "—";
  const title = !roll
    ? "No runs yet"
    : roll.costUsd != null
      ? `${fmtNum(roll.tokensIn)} in / ${fmtNum(roll.tokensOut)} out tokens${roll.uncostedRuns ? ` · ${roll.uncostedRuns} run${roll.uncostedRuns === 1 ? "" : "s"} not costed by the vendor` : ""}`
      : "Vendor doesn't report cost for this run";
  return { label, title };
}

// Sums usage across a set of rollups (e.g. one per provider) into a single
// fleet-wide total — same null-vs-uncosted semantics as addRun/UsageRollup
// itself (costUsd stays null only when NOTHING in the set reported one).
function sumRollups(rolls: UsageRollup[]): UsageRollup {
  const total: UsageRollup = { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: null, uncostedRuns: 0 };
  for (const r of rolls) {
    total.runCount += r.runCount;
    total.tokensIn += r.tokensIn;
    total.tokensOut += r.tokensOut;
    total.uncostedRuns += r.uncostedRuns;
    if (r.costUsd != null) total.costUsd = (total.costUsd ?? 0) + r.costUsd;
  }
  return total;
}

/** The Fleet layout's right column (roadmap "UI system polish" — the
 *  deferred purposeful two-column redesign, not just a centering fix):
 *  aggregate utilization against the runner cap, fleet-wide spend, and a
 *  per-provider cost breakdown. Pure derivation over what FleetView already
 *  loaded — no new fetch. */
function FleetOverview({
  fleet,
  runs,
  providers,
  usageByProvider,
  maxRunners,
  busyCount,
}: {
  fleet: Agent[];
  runs: TaskRun[];
  providers: ProviderInfo[];
  usageByProvider: Record<string, UsageRollup>;
  maxRunners: number;
  busyCount: number;
}) {
  const idleCount = fleet.length - busyCount;
  const total = sumRollups(Object.values(usageByProvider));
  const totalCost = costOf(total);
  const reliability = computeReliability(runs.filter((r) => r.status === "done"));
  const providerRows = Object.entries(usageByProvider)
    .filter(([, roll]) => roll.runCount > 0)
    .sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  return (
    <aside className="panel fleet-overview">
      <div className="panel-head">Fleet overview</div>
      <div className="fleet-ov-stats">
        <div className="fleet-ov-stat">
          <span className="fleet-ov-stat-n mono">{fleet.length}</span>
          <span className="fleet-ov-stat-lbl">Agents</span>
        </div>
        <div className="fleet-ov-stat">
          <span className="fleet-ov-stat-n mono">{busyCount}</span>
          <span className="fleet-ov-stat-lbl">Working</span>
        </div>
        <div className="fleet-ov-stat">
          <span className="fleet-ov-stat-n mono">{idleCount}</span>
          <span className="fleet-ov-stat-lbl">Idle</span>
        </div>
        <div className="fleet-ov-stat">
          <span className="fleet-ov-stat-n mono">{reliability.pct == null ? "—" : `${reliability.pct}%`}</span>
          <span
            className="fleet-ov-stat-lbl"
            title={
              reliability.pct == null
                ? "No finished runs yet"
                : `${reliability.finished} finished run${reliability.finished === 1 ? "" : "s"} fleet-wide`
            }
          >
            Merged clean
          </span>
        </div>
      </div>
      {maxRunners > 0 && (
        <div className="fleet-ov-util">
          <div className="fleet-ov-util-row">
            <span>Utilization</span>
            <span className="mono">
              {busyCount} / {maxRunners}
            </span>
          </div>
          <div className="fleet-ov-util-track">
            <div
              className="fleet-ov-util-fill"
              style={{ width: `${Math.min(100, Math.round((busyCount / maxRunners) * 100))}%` }}
            />
          </div>
        </div>
      )}
      <div>
        <div className="fleet-ov-cost-total">
          <span className="fleet-ov-cost-total-n mono" title={totalCost.title}>
            {totalCost.label}
          </span>
          <span className="fleet-ov-cost-total-meta">total spend</span>
        </div>
        {providerRows.length > 0 ? (
          <div className="fleet-ov-providers" style={{ marginTop: 10 }}>
            {providerRows.map(([id, roll]) => {
              const p = providers.find((x) => x.id === id);
              const cost = costOf(roll);
              return (
                <div className="fleet-ov-provider-row" key={id}>
                  {p && <span style={{ color: p.color }}>{p.glyph}</span>}
                  <span className="fleet-ov-provider-name">{p?.name ?? id}</span>
                  <span className="fleet-ov-provider-cost mono" title={cost.title}>
                    {cost.label}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="fleet-ov-empty">No runs yet — spend shows here once an agent starts working.</p>
        )}
      </div>
    </aside>
  );
}

// ─── Working now: a full card with live task context — unchanged from
// before except it's always busy here (the idle branch moved to AgentRow,
// below) ─────────────────────────────────────────────────────────────────
/**
 * "This is not standard Claude." A runner on a compatible endpoint still shows
 * the Claude provider glyph and name — because it genuinely is the Claude Agent
 * SDK driving it — so without this the operator has no way to tell which vendor
 * actually served the tokens, or why a run's cost looks unfamiliar.
 * Renders nothing for Anthropic's own API, which needs no flag.
 */
function EndpointChip({ endpoint }: { endpoint: string | null }) {
  const label = endpointLabel(endpoint);
  if (!label) return null;
  return (
    <span className="fleet-endpoint" title={`Not Anthropic — this runs against ${endpoint}`}>
      via {label}
    </span>
  );
}

function AgentCard({
  r,
  busy,
  p,
  count,
  costRoll,
  runs,
  hitl,
  now,
  actions,
  endpoint,
  informMode,
  informSelected,
  onToggleInform,
  managerWorkers,
}: {
  r: Agent;
  busy: TaskRun;
  /** Compatible endpoint this agent's credential points at, or null for
   *  Anthropic. Flagged on the card so a non-Claude runner is never mistaken
   *  for a Claude one — the provider glyph alone still says "Claude Code". */
  endpoint: string | null;
  p: ProviderInfo;
  count: number;
  // Vendor-reported cost/tokens summed across this agent's runs — see
  // computeUsageRollup (lib/derive.ts). Undefined = no runs yet.
  costRoll: UsageRollup | undefined;
  // Full run list, for the reliability readout (grouped by agentId itself).
  runs: TaskRun[];
  // The busy run's open gate, if any — see classifyRun. Present → "Answer";
  // absent while the run itself reads as blocked (stale heartbeat, nothing
  // pending) → "Unstick".
  hitl: HitlItem | undefined;
  now: number;
  actions: AgentActions;
  // Mass inform (roadmap "Mass inform") — only meaningful here since only a
  // BUSY agent has a live run to attach a note to; the idle AgentRow below
  // never renders the picker at all. Optional so callers outside FleetView
  // (none today) aren't forced to wire inform state through.
  informMode?: boolean;
  informSelected?: boolean;
  onToggleInform?: () => void;
  // A manager's expandable worker list, pre-rendered by the caller (which
  // already has `runs`/`fleet` in scope) — undefined for a plain worker agent.
  managerWorkers?: ReactNode;
}) {
  const cost = costOf(costRoll);
  const { tag } = classifyRun(busy, hitl, now, STALE_HEARTBEAT_SEC);
  // supportsInform is undefined for every provider except Copilot (back-compat
  // default: supported) — see ProviderInfo.supportsInform.
  const informSupported = p.supportsInform !== false;
  return (
    <div className="fleet-card fleet-busy">
      {informMode &&
        (informSupported ? (
          <label className="fleet-inform-pick" title="Include this agent in the note">
            <input type="checkbox" checked={!!informSelected} onChange={onToggleInform} />
          </label>
        ) : (
          <label className="fleet-inform-pick fleet-inform-unsupported" title={`${p.name} doesn't support inform yet`}>
            <input type="checkbox" disabled />
            not supported
          </label>
        ))}
      <button className="fleet-cardhead" title="Open this agent's detail & task history" onClick={() => actions.onOpenAgent(r.id)}>
        <div className="fleet-top">
          <span className="fleet-prov" style={{ color: p.color }}>
            {p.glyph}
          </span>
          <span className="fleet-rn mono">{r.name}</span>
          {r.role === "manager" && (
            <span className="fleet-manager-badge" title="Manager — decomposes the work and delegates to worker agents it spawns">
              ⌂ manager
            </span>
          )}
          <span className="fleet-state fleet-state-busy">
            <span className="dot dot-running" />
            busy
          </span>
          <span className="fleet-caret" aria-hidden="true">›</span>
        </div>
        <div className="fleet-meta">
          <span className="fleet-pname">{p.name}</span>
          <EndpointChip endpoint={endpoint} />
          <span className="fleet-model mono">{r.model}</span>
          <span className="fleet-histcount">
            {count} task{count === 1 ? "" : "s"}
          </span>
          <span className="fleet-cost mono" title={cost.title}>
            {cost.label}
          </span>
          <ReliabilityReadout agentId={r.id} runs={runs} />
        </div>
      </button>
      <button className="fleet-task fleet-task-link" onClick={() => actions.onOpenTask(busy.id)} title="Open this agent's live activity">
        <span className="fleet-task-name">▸ {busy.name}</span>
        <span className="fleet-task-cta">activity →</span>
      </button>
      <div className="fleet-task-bar" title={`${Math.round(busy.progress * 100)}% through its plan`}>
        <div className="fleet-task-fill" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
      </div>
      <div className="fleet-actions">
        {tag === "blocked" && (
          hitl ? (
            <button
              className="btn btn-ghost fleet-answer"
              title="A decision is waiting on this run — open it."
              onClick={() => actions.onAnswer(busy.id)}
            >
              Answer
            </button>
          ) : (
            <button
              className="btn btn-ghost fleet-unstick"
              title="No heartbeat in a while and nothing pending — stop it so a human (or the autonomy loop) can pick up fresh."
              onClick={() => actions.onUnstick(r, busy.id)}
            >
              Unstick
            </button>
          )
        )}
        <button
          className={"btn btn-ghost fleet-reviewer" + (r.canReview === false ? " off" : "")}
          title={
            r.canReview === false
              ? "Reviewer off — this agent is never picked to review other agents' finished runs. Click to allow."
              : "Reviewer on — this agent may auto-review other agents' finished runs (never its own). Click to disable."
          }
          aria-pressed={r.canReview !== false}
          onClick={() => actions.onToggleReviewer(r)}
        >
          {r.canReview === false ? "Reviewer: off" : "Reviewer: on"}
        </button>
        <button className="btn btn-ghost" onClick={() => actions.onConfigure(r)}>
          Configure
        </button>
        <button
          className="btn btn-ghost"
          title="Duplicate — create a new agent with the same provider & model (no history); you name it"
          onClick={() => actions.onDuplicate(r)}
        >
          Duplicate
        </button>
      </div>
      {managerWorkers}
    </div>
  );
}

// ─── Idle: a compact, scannable row instead of a full card — several
// identical "idle 6d" cards carry no signal; a row reclaims the space for
// what does (Working now, above). Idle time escalates to danger styling
// past a day, so a genuinely stale agent doesn't read identically to one
// that just finished a task a moment ago. ──────────────────────────────────
const STALE_IDLE_MS = 24 * 60 * 60 * 1000;

function AgentRow({
  r,
  p,
  count,
  costRoll,
  runs,
  now,
  endpoint,
  actions,
}: {
  r: Agent;
  p: ProviderInfo;
  endpoint: string | null;
  count: number;
  costRoll: UsageRollup | undefined;
  // Full run list, for the reliability readout (grouped by agentId itself).
  runs: TaskRun[];
  now: number;
  actions: AgentActions;
}) {
  const stale = r.idleSince != null && now - r.idleSince > STALE_IDLE_MS;
  const cost = costOf(costRoll);
  return (
    <div className="fleet-idle-row">
      <button className="fleet-idle-name" title="Open this agent's detail & task history" onClick={() => actions.onOpenAgent(r.id)}>
        <span className="fleet-prov fleet-prov-sm" style={{ color: p.color }}>
          {p.glyph}
        </span>
        <span className="fleet-rn mono">{r.name}</span>
        {/* Inside the name, NOT a sibling: the row is a fixed grid
            (name/tasks/cost/reliability/time/actions), so an extra top-level
            child lands in an implicit extra cell and wraps the actions onto
            their own line. */}
        <EndpointChip endpoint={endpoint} />
      </button>
      <span className="fleet-idle-tasks mono">
        {count} task{count === 1 ? "" : "s"}
      </span>
      <span className="fleet-idle-cost mono" title={cost.title}>
        {cost.label}
      </span>
      <ReliabilityReadout agentId={r.id} runs={runs} />
      <span className={"fleet-idle-time mono" + (stale ? " stale" : "")}>idle {runnerIdleLabel(r, now)}</span>
      <span className="fleet-idle-actions">
        <button
          className={"icon-btn" + (r.canReview === false ? " off" : "")}
          title={r.canReview === false ? "Reviewer off — click to allow" : "Reviewer on — click to disable"}
          aria-pressed={r.canReview !== false}
          onClick={() => actions.onToggleReviewer(r)}
        >
          ✓
        </button>
        <button className="icon-btn" title="Configure" onClick={() => actions.onConfigure(r)}>
          ⚙
        </button>
        <button className="icon-btn" title="Message — ask Steward what this idle agent should pick up" onClick={() => actions.onMessage(r)}>
          💬
        </button>
        <button className="icon-btn" title="Duplicate" onClick={() => actions.onDuplicate(r)}>
          ⧉
        </button>
        <button className="icon-btn icon-btn-danger" title="Retire this agent" onClick={() => actions.onRetire(r)}>
          ⏻
        </button>
      </span>
    </div>
  );
}

// A manager's delegated workers — a run's parentId points at the manager's
// run exactly like a plain fork's does (see lib/derive's workersOf), so this
// is scoped to the manager's CURRENT run only, not its full history.
// Collapsed by default: a busy manager card is already the tallest thing on
// the board, and this only needs a click away, not always-open real estate.
function ManagerWorkers({
  workers,
  fleet,
  onOpenTask,
}: {
  workers: TaskRun[];
  fleet: Agent[];
  onOpenTask: (id: string) => void;
}) {
  if (workers.length === 0) return null;
  const done = workers.filter((w) => w.status === "done").length;
  return (
    <details className="fleet-manager-workers">
      <summary className="fleet-manager-summary mono">
        {done}/{workers.length} workers
      </summary>
      <div className="fleet-manager-worker-list">
        {workers.map((w) => (
          <button
            key={w.id}
            className="fleet-manager-worker-row"
            title="Open this worker's activity"
            onClick={() => onOpenTask(w.id)}
          >
            <StatusDot status={w.status} />
            <span className="fleet-manager-worker-name mono">{runnerName(w, fleet)}</span>
            <span className="fleet-manager-worker-task">{w.name}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

export function FleetView({
  onOpenTask,
  onOpenAgent,
}: {
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const { fleet, runs, queue, providers, workspaceSettings, createAgent, updateAgent, deleteAgent, informRuns, stopAgent } =
    useStore();
  const confirm = useConfirm();
  // Mass inform (roadmap "Mass inform"): pick a set of BUSY agents (only a
  // live run has a next turn to ride a note on) and attach a note that rides
  // each one's next prompt at no extra turn — see InformComposer below.
  const [informMode, setInformMode] = useState(false);
  const [informSelected, setInformSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // The agent being duplicated: opens the same form pre-filled with its provider
  // + model + credential (no history), so the operator only names the copy.
  const [cloneFrom, setCloneFrom] = useState<Agent | null>(null);
  const now = Date.now();
  // Credential metadata, so every agent card can say which vendor actually
  // serves it. Fetched once here rather than per-card: the endpoint is a
  // property of the runner's CONFIGURED credential, and an idle agent has no
  // run to read it off.
  const [fleetSecrets, setFleetSecrets] = useState<SecretMeta[]>([]);
  useEffect(() => {
    api.fetchSecrets().then((r) => setFleetSecrets(r.secrets)).catch(() => setFleetSecrets([]));
  }, []);
  const endpointOf = (a: Agent): string | null =>
    fleetSecrets.find((c) => c.id === (a.credentialId ?? a.provider))?.baseUrl ?? null;
  // A runner on a benched key takes no work at all — distinct from merely
  // queueing behind the concurrency cap, and worth saying separately.
  const pausedKeyOf = (a: Agent) => fleetSecrets.find((c) => c.id === (a.credentialId ?? a.provider))?.paused ?? null;
  const pausedCount = fleet.filter((a) => !!pausedKeyOf(a)).length;
  const maxRunners = workspaceSettings?.maxRunners ?? 0;
  const takenNames = new Set(fleet.map((a) => a.name));

  const taskCountOf = (r: Agent) => runs.filter((a) => a.agentId === r.id).length;
  // Vendor-reported cost/tokens, summed across this agent's runs (excludes
  // archived — see computeUsageRollup). Computed once per render, not per card
  // — byProvider feeds the overview panel's fleet-wide breakdown below.
  const usageRollup = computeUsageRollup(runs);
  const usageByAgent = usageRollup.byAgent;

  const busyOf = (r: Agent) =>
    runs.find((a) => a.status !== "done" && a.agentId === r.id);
  const busyCount = fleet.filter((r) => !!busyOf(r)).length;
  // The busy run's own open gate, if any — see classifyRun (Answer vs Unstick).
  const hitlOf = (runId: string) => queue.find((q) => q.runId === runId && !q.resolvedAt);

  const actions: AgentActions = {
    onOpenAgent,
    onOpenTask,
    onConfigure: (r) => {
      setEditing(r.id);
      setAdding(false);
      setCloneFrom(null);
    },
    onDuplicate: (r) => {
      setCloneFrom(r);
      setAdding(false);
      setEditing(null);
    },
    onToggleReviewer: (r) => updateAgent(r.id, { canReview: r.canReview === false }),
    onRetire: async (r) => {
      if (
        await confirm({
          title: "Retire this agent?",
          body: `“${r.name}” is removed from the fleet — its run history is preserved, but it can't pick up new work.`,
          confirmLabel: "Retire",
          danger: true,
        })
      )
        deleteAgent(r.id);
    },
    onAnswer: onOpenTask,
    onUnstick: async (r, runId) => {
      if (
        await confirm({
          title: "Unstick this run?",
          body: `“${r.name}” hasn't reported in a while and there's no decision waiting on it. Stopping frees the runner so it (or another agent) can pick up fresh — the work isn't lost.`,
          confirmLabel: "Stop & free the runner",
          danger: true,
        })
      )
        void stopAgent(runId);
    },
    onMessage: (r) =>
      window.dispatchEvent(
        new CustomEvent("skynet:open-steward", { detail: { text: `What should ${r.name} pick up next?` } }),
      ),
  };

  // Group the fleet by label. Named groups sort alphabetically; the "Ungrouped"
  // bucket (agents with no label) always comes last. Order within a group keeps
  // the fleet's own order. A single-group fleet (all ungrouped — today's default)
  // renders exactly as before: one grid, no heading.
  const UNGROUPED = " ungrouped"; // sentinel key that can't collide with a real label
  const groups = new Map<string, Agent[]>();
  for (const a of fleet) {
    const key = a.label?.trim() || UNGROUPED;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });
  const showHeadings = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== UNGROUPED);

  // A group's agents rendered as ConfigForm-in-place when being edited (both
  // densities share this — editing always shows the full form, regardless of
  // whether the agent was busy or idle a moment ago).
  const renderEditable = (r: Agent) => (
    <div key={r.id} className="fleet-card">
      <ConfigForm
        initial={r}
        onSave={(u) => {
          updateAgent(r.id, { model: u.model, name: u.name || undefined, label: u.label, credentialId: u.credentialId ?? null });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    </div>
  );

  return (
    <section className="vw">

      {/* maxRunners caps CONCURRENCY, not roster size — adding agents is never
          blocked. So when the roster is larger than the cap, say what will
          actually happen rather than letting an operator wonder why their
          eleventh runner never picks anything up. */}
      {maxRunners > 0 && fleet.length > maxRunners && (
        <div className="fleet-cap-note">
          <b>{fleet.length} agents configured, {maxRunners} work at once.</b> The rest wait for a runner to
          free up — nothing is lost, tasks just queue. Raise <em>max runners</em> in Settings to widen it.
          {pausedCount > 0 && ` ${pausedCount} agent${pausedCount === 1 ? " is" : "s are"} on a paused key and won't take work at all.`}
        </div>
      )}
      <div className="fleet-head">
        <div className="vw-head">
          <h1>Agent fleet</h1>
          <p>
            {fleet.length} agent{fleet.length === 1 ? "" : "s"} configured · catalog: Claude, Codex, Gemini, Cursor, Copilot
          </p>
        </div>
        <div className="fleet-head-actions">
          {fleet.some((r) => !!busyOf(r)) && (
            <button
              className={"btn btn-ghost" + (informMode ? " on" : "")}
              title="Select busy agents and attach a note that rides each one's next prompt — no extra turn, no reply expected."
              onClick={() => {
                setInformMode((v) => !v);
                setInformSelected(new Set());
              }}
            >
              📣 Mass inform
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => {
              setAdding(true);
              setEditing(null);
              setCloneFrom(null);
            }}
          >
            + Add agent
          </button>
        </div>
      </div>
      {informMode && (
        <InformComposer
          count={informSelected.size}
          onCancel={() => {
            setInformMode(false);
            setInformSelected(new Set());
          }}
          onSend={async (note) => {
            const runIds = fleet
              .map((r) => (informSelected.has(r.id) ? busyOf(r)?.id : undefined))
              .filter((id): id is string => !!id);
            const { informed, skipped } = await informRuns({ note, runIds });
            toastInformResult(informed.length, skipped.length);
            setInformMode(false);
            setInformSelected(new Set());
          }}
        />
      )}
      {(adding || cloneFrom) && (
        <div className="panel cfg-panel">
          <div className="panel-head">{cloneFrom ? `DUPLICATE · ${cloneFrom.name}` : "NEW AGENT"}</div>
          <ConfigForm
            // Remount when the source changes so the form re-seeds from `initial`.
            key={cloneFrom ? "clone-" + cloneFrom.id : "new"}
            initial={cloneFrom ? { ...cloneFrom, name: suggestCloneName(cloneFrom.name, takenNames) } : undefined}
            submitLabel={cloneFrom ? "Add to fleet" : undefined}
            onSave={(r) => {
              // The credential the operator actually PICKED wins. This used to
              // pass only `cloneFrom?.credentialId`, silently discarding the
              // form's own Key selection on every non-clone add — so an agent
              // pinned to a second key (or to a compatible endpoint) quietly
              // ran on the provider's default one instead.
              createAgent(r.provider, r.model, r.name || undefined, r.credentialId ?? cloneFrom?.credentialId ?? undefined, r.label);
              setAdding(false);
              setCloneFrom(null);
            }}
            onCancel={() => {
              setAdding(false);
              setCloneFrom(null);
            }}
          />
        </div>
      )}
      <div className="fleet-layout">
        <div className="fleet-main">
          {groupKeys.map((gk) => {
            const groupAgents = groups.get(gk)!;
            const busyAgents = groupAgents.filter((r) => busyOf(r));
            const idleAgents = groupAgents.filter((r) => !busyOf(r));
            const showSubLabels = busyAgents.length > 0 && idleAgents.length > 0;
            return (
              <div key={gk} className="fleet-group">
                {showHeadings && (
                  <div className="fleet-group-head">
                    <span className="fleet-group-name">{gk === UNGROUPED ? "Ungrouped" : gk}</span>
                    <span className="fleet-group-count mono">{groupAgents.length}</span>
                  </div>
                )}
                {busyAgents.length > 0 && (
                  <div className="fleet-working">
                    {showSubLabels && (
                      <div className="fleet-sub-label">
                        Working now <span className="mono">{busyAgents.length}</span>
                      </div>
                    )}
                    <div className="fleet-grid">
                      {busyAgents.map((r) =>
                        editing === r.id
                          ? renderEditable(r)
                          : (
                            <AgentCard
                              key={r.id}
                              r={r}
                              busy={busyOf(r)!}
                              p={providerInfo(providers, r.provider)}
                              count={taskCountOf(r)}
                              costRoll={usageByAgent[r.id]}
                              runs={runs}
                              hitl={hitlOf(busyOf(r)!.id)}
                              now={now}
                              endpoint={endpointOf(r)}
                              actions={actions}
                              informMode={informMode}
                              informSelected={informSelected.has(r.id)}
                              onToggleInform={() =>
                                setInformSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(r.id)) next.delete(r.id);
                                  else next.add(r.id);
                                  return next;
                                })
                              }
                              managerWorkers={
                                r.role === "manager" ? (
                                  <ManagerWorkers workers={workersOf(busyOf(r)!.id, runs)} fleet={fleet} onOpenTask={onOpenTask} />
                                ) : undefined
                              }
                            />
                          ),
                      )}
                    </div>
                  </div>
                )}
                {idleAgents.length > 0 && (
                  <div className="fleet-idle">
                    {showSubLabels && (
                      <div className="fleet-sub-label">
                        Idle <span className="mono">{idleAgents.length}</span>
                      </div>
                    )}
                    <div className="fleet-idle-roster">
                      {idleAgents.map((r) =>
                        editing === r.id ? (
                          <div key={r.id} className="fleet-idle-editing">
                            <ConfigForm
                              initial={r}
                              onSave={(u) => {
                                // Same patch as renderEditable's — the idle roster has
                                // its own inline editor, and omitting credentialId here
                                // silently dropped a vendor switch made from this form.
                                updateAgent(r.id, { model: u.model, name: u.name || undefined, label: u.label, credentialId: u.credentialId ?? null });
                                setEditing(null);
                              }}
                              onCancel={() => setEditing(null)}
                            />
                          </div>
                        ) : (
                          <AgentRow
                            key={r.id}
                            r={r}
                            p={providerInfo(providers, r.provider)}
                            count={taskCountOf(r)}
                            costRoll={usageByAgent[r.id]}
                            runs={runs}
                            now={now}
                            endpoint={endpointOf(r)}
                            actions={actions}
                          />
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <FleetOverview
          fleet={fleet}
          runs={runs}
          providers={providers}
          usageByProvider={usageRollup.byProvider}
          maxRunners={maxRunners}
          busyCount={busyCount}
        />
      </div>
    </section>
  );
}
