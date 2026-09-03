// ─── Keys & Budget panel — "Boundaries" (Momentum Rollout Phase 17, TASK 20) ──
// Boundaries set once so oversight isn't a running watch: provider-key
// governance (which keys, org-owned or personal), command approval boundaries
// (the standing allowlist AND its counterpart, exact commands that must
// always gate — Project.alwaysGateCommands, new here), the project-level
// default for a NEW automation rule's safety rails (Project.ruleSafetyDefaults,
// reusing rules.tsx's SafetyRailsCard as-is), and a daily-budget visualization
// (byProvider/byCredential rollups — derive.ts — over data already recorded on
// every TaskRun, no new collection). Every mutation here goes through the
// SAME Project fields the rest of the app reads/writes (approvalRules,
// alwaysGateCommands, ruleSafetyDefaults, dailyBudgetUsd), so a change lands
// live via the existing `project.upserted` WS delta — no separate live-update
// plumbing needed, and a pattern added elsewhere (e.g. a HITL "Always allow")
// shows up here with no reload, and vice versa.
import { useEffect, useMemo, useState } from "react";
import type { Project, ProviderId, SecretMeta, TaskRun } from "@skynet/shared";
import { computeDailySpend, DEFAULT_BUDGET_PACING_WINDOW_MS } from "@skynet/shared";
import { computeUsageRollup, fmtCost, providerInfo, type UsageRollup } from "../lib/derive";
import * as api from "../lib/client";
import { useStore, useNow } from "../lib/store";
import { SafetyRailsCard } from "./rules";
import { toast } from "../components/toast";

// UI-only warn line drawn on the budget meter — 80% of the daily budget. Not
// a new backend concept: purely a visual marker so an operator sees the
// warning line coming before spend actually crosses it.
const WARN_THRESHOLD_FRACTION = 0.8;

function ChipAddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (value: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  return (
    <div className="kbb-chip-add-wrap">
      <input
        className="kbb-chip-add-input"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={submit}
      />
    </div>
  );
}

// ── Provider key rows ───────────────────────────────────────────────────────
interface KeyCandidate {
  id: string;
  provider: ProviderId;
  label: string;
  last4?: string;
  orgOwned: boolean;
  paused: boolean;
  stored: boolean; // false = an env-backed default with no credential row to toggle
}

function ProviderKeysCard({ project, runs }: { project: Project; runs: TaskRun[] }) {
  const { providers } = useStore();
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const reload = () => {
    api.fetchSecrets().then(({ secrets }) => setSecrets(secrets.filter((s) => s.provider !== "github" && s.provider !== "fly"))).catch(() => setSecrets([]));
  };
  useEffect(reload, []);

  const byCredential = useMemo(() => computeUsageRollup(runs).byCredential, [runs]);

  const seen = new Set(secrets.map((s) => s.id));
  const candidates: KeyCandidate[] = [
    ...secrets.map((s): KeyCandidate => ({
      id: s.id,
      provider: s.provider as ProviderId,
      label: s.name || `${providerInfo(providers, s.provider as ProviderId).name}${s.isDefault ? " default" : " key"}`,
      last4: s.last4,
      orgOwned: s.orgOwned,
      paused: !!s.paused,
      stored: true,
    })),
    ...providers
      .filter((p) => p.available && !seen.has(p.id))
      .map((p): KeyCandidate => ({ id: p.id, provider: p.id, label: `${p.name} default (via env)`, orgOwned: false, paused: false, stored: false })),
  ];
  // Scoped to what this project can actually run on — empty enabledRunnerCredentialIds
  // means "any workspace key" (the default), matching ProjectRunnerKeys' own reading.
  const scoped = project.enabledRunnerCredentialIds.length === 0
    ? candidates
    : candidates.filter((c) => project.enabledRunnerCredentialIds.includes(c.id));

  const toggleOrgOwned = async (id: string, current: boolean) => {
    try {
      await api.setCredentialOrgOwned(id, !current);
    } catch (e) {
      // Previously silent — a rejection (already-resolved, network blip)
      // left the checkbox re-synced with zero feedback about WHY it reverted.
      toast(e instanceof Error ? e.message : "Couldn't update that.");
    } finally {
      reload();
    }
  };

  if (scoped.length === 0) return null; // nothing usable to govern yet

  return (
    <div className="kbb-card">
      <div className="kbb-card-head">Provider keys</div>
      <div className="kbb-key-list">
        {scoped.map((c) => {
          const info = providerInfo(providers, c.provider);
          const roll: UsageRollup | undefined = byCredential[c.id];
          return (
            <div key={c.id} className={"kbb-key-row" + (!c.orgOwned ? " kbb-key-row-warn" : "")}>
              <span className={"kbb-dot " + (c.paused ? "kbb-dot-paused" : "kbb-dot-active")} title={c.paused ? "Benched" : "Active"} />
              <span className="kbb-key-glyph" style={{ color: info.color }}>{info.glyph}</span>
              <span className="kbb-key-label">{info.name} · {c.label}</span>
              {c.last4 && <span className="kbb-key-fp mono">····{c.last4}</span>}
              {roll && roll.costUsd != null && (
                <span className="kbb-key-spend mono" title="Lifetime known spend on this credential">
                  {fmtCost(roll.costUsd)}
                </span>
              )}
              {!c.orgOwned && <span className="kbb-key-warn-label">not org-owned</span>}
              {c.stored ? (
                <label className="kbb-key-org-toggle" title="Is this the workspace's OWN key, or someone's personal key running agent work? Never auto-detected — set it explicitly.">
                  <input type="checkbox" checked={c.orgOwned} onChange={() => void toggleOrgOwned(c.id, c.orgOwned)} />
                  org-owned
                </label>
              ) : (
                <span className="kbb-key-env-note">no stored credential to flag</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Allowlist / always-gated command boundaries ─────────────────────────────
function AllowlistCard({ project }: { project: Project }) {
  const { addApprovalRule, removeApprovalRule } = useStore();
  return (
    <div className="kbb-card">
      <div className="kbb-card-head">
        Allowlist <span className="kbb-card-hint">— auto-approved without asking (same list a HITL "Always allow" writes to)</span>
      </div>
      <div className="kbb-chip-row">
        {project.approvalRules.map((r) => (
          <span key={r.id} className="ak-chip ak-chip-machine kbb-chip">
            {r.command}
            <button className="kbb-chip-remove" aria-label={`Stop auto-approving ${r.command}`} onClick={() => void removeApprovalRule(project.id, r.id)}>×</button>
          </span>
        ))}
        <ChipAddInput placeholder="+ add pattern" onAdd={(v) => void addApprovalRule(project.id, v)} />
      </div>
      {project.approvalRules.length === 0 && (
        <p className="kbb-card-hint-text">No standing allowances yet — approve a command with "Always allow" in the Inbox, or add one directly above.</p>
      )}
    </div>
  );
}

function AlwaysGatedCard({ project }: { project: Project }) {
  const { updateProject } = useStore();
  const add = (v: string) => {
    if (project.alwaysGateCommands.includes(v)) return;
    void updateProject(project.id, { alwaysGateCommands: [...project.alwaysGateCommands, v] });
  };
  const remove = (c: string) => void updateProject(project.id, { alwaysGateCommands: project.alwaysGateCommands.filter((x) => x !== c) });
  return (
    <div className="kbb-card">
      <div className="kbb-card-head">
        Always gated <span className="kbb-card-hint">— never auto-approved, no matter the approval level or a standing rule</span>
      </div>
      <div className="kbb-chip-row">
        {project.alwaysGateCommands.map((c) => (
          <span key={c} className="ak-chip ak-chip-warn kbb-chip">
            {c}
            <button className="kbb-chip-remove" aria-label={`Stop always-gating ${c}`} onClick={() => remove(c)}>×</button>
          </span>
        ))}
        <ChipAddInput placeholder="+ add pattern" onAdd={add} />
      </div>
      {project.alwaysGateCommands.length === 0 && (
        <p className="kbb-card-hint-text">Nothing carved out yet — every command still follows the approval level + allowlist above.</p>
      )}
    </div>
  );
}

// ── Daily budget visualization ──────────────────────────────────────────────
function DailyBudgetCard({ project, runs }: { project: Project; runs: TaskRun[] }) {
  const { providers, updateProject } = useStore();
  const now = useNow(30_000);
  const spend = useMemo(() => computeDailySpend(runs, project.id, now), [runs, project.id, now]);
  const budget = project.dailyBudgetUsd;

  const [draft, setDraft] = useState(budget == null ? "" : String(budget));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(budget == null ? "" : String(budget));
  }, [budget, editing]);
  const commitBudget = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") return void updateProject(project.id, { dailyBudgetUsd: null });
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return setDraft(budget == null ? "" : String(budget));
    void updateProject(project.id, { dailyBudgetUsd: n });
  };

  // Today's runs only — the breakdown is of what's actually inside the
  // spend window computeDailySpend just used, so the sum of the rows always
  // reconciles with the headline number above them.
  const todaysRuns = useMemo(
    () => runs.filter((r) => r.projectId === project.id && r.startedAt >= spend.windowStart && r.startedAt < spend.windowEnd),
    [runs, project.id, spend.windowStart, spend.windowEnd],
  );
  const byProvider = useMemo(() => computeUsageRollup(todaysRuns).byProvider, [todaysRuns]);
  const providerRows = Object.entries(byProvider).sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  const pct = budget ? Math.min(1, spend.spentUsd / budget) : 0;
  const warnPct = Math.min(1, WARN_THRESHOLD_FRACTION);
  const exhausted = budget != null && spend.spentUsd >= budget;

  return (
    <div className="kbb-card">
      <div className="kbb-card-head">Daily budget</div>
      <div className="kbb-budget-headline">
        <span className="kbb-budget-amount mono">{fmtCost(spend.spentUsd)}</span>
        <span className="kbb-budget-of">
          of{" "}
          <label className="kbb-budget-input-wrap">
            <span className="mono">$</span>
            <input
              className="kbb-budget-input mono"
              type="number"
              min={0}
              step="0.01"
              placeholder="no limit"
              value={draft}
              onFocus={() => setEditing(true)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitBudget}
            />
          </label>{" "}
          today
        </span>
        {exhausted && <span className="kbb-budget-exhausted">⏸ exhausted</span>}
      </div>
      {budget != null && (
        <div className="kbb-meter" role="img" aria-label={`${fmtCost(spend.spentUsd)} of ${fmtCost(budget)} spent today`}>
          <div className="kbb-meter-fill" style={{ width: `${pct * 100}%` }} />
          <div className="kbb-meter-tick kbb-meter-tick-current" style={{ left: `${pct * 100}%` }} title={`Current spend: ${fmtCost(spend.spentUsd)}`} />
          <div className="kbb-meter-tick kbb-meter-tick-warn" style={{ left: `${warnPct * 100}%` }} title={`Warn line: ${fmtCost(budget * WARN_THRESHOLD_FRACTION)} (${Math.round(WARN_THRESHOLD_FRACTION * 100)}%)`} />
        </div>
      )}
      {providerRows.length > 0 && (
        <div className="kbb-budget-breakdown">
          {providerRows.map(([provider, roll]) => {
            const info = providerInfo(providers, provider as ProviderId);
            return (
              <div key={provider} className="kbb-budget-row">
                <span className="kbb-key-glyph" style={{ color: info.color }}>{info.glyph}</span>
                <span className="kbb-budget-row-label">{info.name}</span>
                <span className="kbb-budget-row-cost mono">{roll.costUsd != null ? fmtCost(roll.costUsd) : "—"}</span>
                <span className="kbb-budget-row-runs mono">{roll.runCount} run{roll.runCount === 1 ? "" : "s"}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="kbb-cap-sentence">
        {budget == null
          ? "No limit set — autonomy picks up new work without checking spend."
          : "Once today's spend reaches the cap, autonomy stops picking up NEW work for the rest of the day. Every run already in flight finishes its current step, commits, and parks normally (review/done) — nothing is stopped abruptly. You can still assign a task manually at any time; the cap only gates autonomous auto-pick."}
        {project.budgetPacing && budget != null && (
          <> Paced: only a fraction of the budget is available to new work early in the day, growing to the full amount over the working window ({Math.round(DEFAULT_BUDGET_PACING_WINDOW_MS / 3_600_000)}h).</>
        )}
      </p>
    </div>
  );
}

// ── Top-level panel ──────────────────────────────────────────────────────────
export function KeysBudgetPanel({ project, runs }: { project: Project; runs: TaskRun[] }) {
  // Phase 30 hardening — the shared status strip (shell.tsx's OpStatusBar)
  // is now the ONE place a disconnect shows; this panel no longer draws its
  // own pill.
  const { updateProject } = useStore();
  return (
    <div className="kbb-wrap">
      <div className="kbb-header">
        <h2 className="kbb-title">Boundaries · {project.name}</h2>
        <p className="kbb-sub">one-time setup · changes are written to the audit trail</p>
      </div>
      <ProviderKeysCard project={project} runs={runs} />
      <AllowlistCard project={project} />
      <AlwaysGatedCard project={project} />
      <SafetyRailsCard
        safety={project.ruleSafetyDefaults}
        onChange={(next) => void updateProject(project.id, { ruleSafetyDefaults: next })}
      />
      <DailyBudgetCard project={project} runs={runs} />
    </div>
  );
}
