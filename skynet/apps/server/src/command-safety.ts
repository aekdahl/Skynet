// ─── Command safety: validate + bound real shell execution ─────────────────
// Once runners execute for real, an `approval` HITL wraps a real shell command
// and the merge queue runs a project `checkCmd` — both are arbitrary shell in a
// worktree that shares the canonical repo's object store. The HITL gate alone
// is not safety: an operator can fat-finger "approve" on `rm -rf /`, and an
// approved command otherwise runs verbatim, unbounded, with the server's full
// environment. This module closes that gap with two primitives:
//
//   1. classifyCommand() — a DENYLIST + risk-score policy, DATA-driven (see
//      `CommandPolicy` in @skynet/shared). Allow read-only commands, hard-DENY a
//      curated set of catastrophic patterns (so they can never be approved), and
//      GATE the rest for human approval with a real risk level. Scans the whole
//      string (so `$(rm -rf /)` and `… | sh` are caught) and is conservative:
//      anything it can't certify safe → gate. A workspace with no custom
//      CommandPolicy (see command-policy.ts) gets DEFAULT_COMMAND_POLICY below,
//      which reproduces the classifier this module shipped with byte-for-byte.
//   2. runBounded() — execute under hard limits: timeout (SIGTERM→SIGKILL),
//      output-size cap, a scrubbed allowlist environment, confined cwd, no
//      inherited stdio. Kernel-level isolation (seccomp/namespaces) is the
//      per-runner container's job (Architecture Brief §07); this bounds the
//      blast radius of whatever the server itself spawns.
//
// Self-contained and opt-in: nothing imports it until Core wires it (see the
// PR notes), so the default mock+memory dev path is unchanged. Limits read from
// the environment at call time with safe defaults.

import { spawn } from "node:child_process";
import type { CommandPolicy, PolicyRule, PolicyRuleKind, Risk } from "@skynet/shared";

// ─── Verdict ────────────────────────────────────────────────────────────────

/** allow = run without a gate · gate = require human approval · deny = never run. */
export type SafetyDecision = "allow" | "gate" | "deny";

export interface CommandVerdict {
  decision: SafetyDecision;
  risk: Risk; // aligns with HitlItem.risk so the gate shows real severity
  reasons: string[]; // human-readable — feeds the HITL `why` and the audit trail
  ruleIds: string[]; // which rules fired (stable ids for logging/analytics)
}

/** Thrown when a hard-denied command is asked to run (defense in depth). */
export class CommandDeniedError extends Error {
  constructor(public readonly verdict: CommandVerdict, command: string) {
    super(`command denied by policy: ${verdict.reasons.join("; ")} — ${command}`);
    this.name = "CommandDeniedError";
  }
}

// ─── Default policy (the classifier this module always shipped with) ────────
// Expressed as CommandPolicy DATA so it's the same shape an operator's custom
// policy takes — this is just what a workspace gets with no custom policy.

interface LegacyRule {
  id: string;
  test: RegExp;
  risk: Risk;
  reason: string;
}

// Catastrophic / irreversible / remote-code-exec — NEVER runs, even if approved.
const DENY_RULES: LegacyRule[] = [
  { id: "rm-root", risk: "high", reason: "recursive remove targeting / , /* , ~ or $HOME", test: /\brm\b[^\n;|&]*\s(?:-{1,2}[a-z-]+\s+)*(?:\/|\/\*|~\/?|\$HOME)(?=[\s;)|&'"\]]|$)/i },
  { id: "fork-bomb", risk: "high", reason: "fork bomb", test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: "mkfs", risk: "high", reason: "filesystem format (mkfs)", test: /\bmkfs(\.\w+)?\b/i },
  { id: "dd-to-device", risk: "high", reason: "dd writing to a block device", test: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/i },
  { id: "redirect-to-device", risk: "high", reason: "redirect to a raw block device", test: />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/i },
  { id: "pipe-net-to-shell", risk: "high", reason: "piping network download straight into a shell", test: /\b(curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/i },
  { id: "base64-to-shell", risk: "high", reason: "decoding and executing an opaque payload", test: /\bbase64\b[^\n]*\s-d[^\n]*\|\s*(sh|bash|zsh|python3?|node)\b/i },
  { id: "sudo", risk: "high", reason: "privilege escalation (sudo)", test: /(^|[\s;&|(])sudo\b/i },
  { id: "write-system-path", risk: "high", reason: "redirect/overwrite into a system directory", test: />>?\s*\/(etc|usr|bin|sbin|boot|sys|proc|System|Library)\b/i },
  { id: "power-state", risk: "high", reason: "host power-state change", test: /\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/i },
  { id: "kill-all", risk: "high", reason: "mass process kill", test: /\bkill\b\s+-9\s+-1\b|\bkillall\b\s+-9\b/i },
  { id: "chmod-recursive-root", risk: "high", reason: "recursive permission change on a system path", test: /\bchmod\b[^\n]*\s-R[^\n]*\s\/(?:\s|$|\w)/i },
  { id: "force-push-protected", risk: "high", reason: "force-push to a protected branch", test: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|--mirror|\s-f\b)[^\n]*\b(main|master|production|release)\b|\bgit\s+push\b[^\n]*\b(main|master|production|release)\b[^\n]*(?:--force|\s-f\b)/i },
];

// Destructive-but-legitimate — must be approved, surfaced as high risk.
const GATE_HIGH_RULES: LegacyRule[] = [
  { id: "rm-recursive-force", risk: "high", reason: "recursive force remove", test: /\brm\b[^\n;|&]*\s-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive|force)\b/i },
  { id: "git-reset-hard", risk: "high", reason: "discards working-tree changes", test: /\bgit\s+reset\b[^\n]*--hard/i },
  { id: "git-clean", risk: "high", reason: "deletes untracked files", test: /\bgit\s+clean\b[^\n]*\s-[a-z]*f/i },
  { id: "git-push", risk: "high", reason: "publishes commits to a remote", test: /\bgit\s+push\b/i },
  { id: "sql-destructive", risk: "high", reason: "destructive SQL (drop/truncate/delete)", test: /\b(drop\s+(table|database|schema)|truncate\b|delete\s+from)\b/i },
  { id: "db-migrate", risk: "high", reason: "database migration", test: /\b(migrate|migration)\b|\bprisma\b[^\n]*\bmigrate\b/i },
  { id: "infra-cli", risk: "high", reason: "infrastructure mutation", test: /\b(docker|kubectl|helm|terraform|aws|gcloud|az)\b/i },
  { id: "pkg-publish", risk: "high", reason: "publishes a package", test: /\b(npm|pnpm|yarn)\s+publish\b/i },
];

// Mutating but lower-stakes — approved, surfaced as medium risk.
const GATE_MEDIUM_RULES: LegacyRule[] = [
  { id: "pkg-install", risk: "medium", reason: "installs dependencies / fetches code", test: /\b(apt|apt-get|yum|dnf|brew|pip3?|gem|cargo)\s+(install|add)\b|\bnpm\s+i(nstall)?\b[^\n]*\s-g\b/i },
  { id: "perm-change", risk: "medium", reason: "changes file permissions/ownership", test: /\b(chmod|chown)\b/i },
  { id: "rm-any", risk: "medium", reason: "removes files", test: /(^|[\s;&|])rm\b/i },
  { id: "git-write", risk: "medium", reason: "writes git history/state", test: /\bgit\s+(commit|merge|rebase|checkout|switch|branch\s+-[dD]|tag\s+-d|stash\s+drop)\b/i },
  { id: "move-copy", risk: "medium", reason: "moves/overwrites files", test: /(^|[\s;&|])(mv|cp)\b/i },
];

// Read-only leading commands — certified safe (low). A command is `allow` only
// when EVERY segment leads with one of these and it has no substitution/redirect.
const ALLOW_LEADERS: RegExp[] = [
  /^(ls|pwd|cat|head|tail|less|more|grep|egrep|fgrep|rg|ag|find|wc|echo|printf|true|false|date|whoami|hostname|uname|env|which|type|file|stat|du|df|tree|sort|uniq|cut|awk|sed\s+-n|jq|column|basename|dirname|realpath|readlink)\b/i,
  /^(node|npm|pnpm|yarn|tsc|python3?|deno|bun)\s+(-v|--version|version)\b/i,
  /^tsc\s+--noemit\b/i,
  /^git\s+(status|log|diff|show|rev-parse|ls-files|ls-tree|describe|blame|fetch|remote\b(?![^\n]*\b(add|remove|set-url)\b)|config\s+--get|branch\s*$|branch\s+(-a|-r|-l|--list|-v)\b|tag\s*$|tag\s+-l\b)/i,
];

const toRule = (r: LegacyRule, kind: PolicyRuleKind): PolicyRule => ({
  id: r.id, kind, pattern: r.test.source, risk: r.risk, reason: r.reason, enabled: true,
});

/** Shipped out of the box — every workspace with no custom `PolicyVersion`
 *  (see command-policy.ts) classifies commands with exactly this data. */
export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  rules: [
    ...DENY_RULES.map((r) => toRule(r, "deny")),
    ...GATE_HIGH_RULES.map((r) => toRule(r, "gate")),
    ...GATE_MEDIUM_RULES.map((r) => toRule(r, "gate")),
    ...ALLOW_LEADERS.map((re, i): PolicyRule => ({ id: `allow-leader-${i}`, kind: "allow-leader", pattern: re.source, risk: "low", reason: "read-only leader", enabled: true })),
  ],
  defaultDecision: "gate",
  defaultRisk: "medium",
  unsafeCompositionBlocksAllow: true,
  resourceCaps: { maxWallClockMs: null, maxTokenBudget: null },
  networkEgress: { enabled: false, allowlist: [] },
};

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_RANK[a] >= RISK_RANK[b] ? a : b);

// Tokens that mean "I can't reason about every code path here" → never `allow`.
const UNSAFE_COMPOSITION = /\$\(|`|<\(|>\(|>>?|^\s*eval\b|[\s;&|]eval\b/;

/** Additional hard-deny patterns from SKYNET_CMD_DENY — merged on top of every
 *  policy (workspace-custom or default) regardless of what the policy itself
 *  contains, same as before this module became policy-driven. */
function readExtraDenyRules(): LegacyRule[] {
  const raw = process.env.SKYNET_CMD_DENY;
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pat, i) => {
      try {
        return { id: `env-deny-${i}`, risk: "high" as Risk, reason: `matches configured deny pattern /${pat}/`, test: new RegExp(pat, "i") };
      } catch {
        console.warn(`[command-safety] ignoring invalid SKYNET_CMD_DENY pattern: ${pat}`);
        return null;
      }
    })
    .filter((r): r is LegacyRule => r !== null);
}

/** Split a command line into the segments a shell would run sequentially. */
function segments(command: string): string[] {
  return command
    .split(/[\n;]|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface CompiledRule { id: string; risk: Risk; reason: string; test: RegExp }

function compileRules(rules: PolicyRule[], kind: PolicyRuleKind): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (r.kind !== kind || r.enabled === false) continue;
    try {
      out.push({ id: r.id, risk: r.risk, reason: r.reason, test: new RegExp(r.pattern, "i") });
    } catch {
      console.warn(`[command-safety] ignoring invalid policy rule pattern (${r.id}): ${r.pattern}`);
    }
  }
  return out;
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify a shell command into allow / gate / deny with a risk level and
 * human-readable reasons, evaluated against `policy` (a workspace's active
 * CommandPolicy, or DEFAULT_COMMAND_POLICY). Deny scanning runs over the whole
 * string (catches hidden substitutions and pipe-to-shell); allow requires every
 * segment to lead with a certified read-only command and contain no
 * substitution/redirection.
 */
export function classifyCommand(command: string, policy: CommandPolicy = DEFAULT_COMMAND_POLICY): CommandVerdict {
  const cmd = command.trim();
  if (!cmd) {
    return { decision: "allow", risk: "low", reasons: ["empty command (no-op)"], ruleIds: [] };
  }

  // 1) Hard deny — checked across the entire command string.
  const denyHits = [...compileRules(policy.rules, "deny"), ...readExtraDenyRules()].filter((r) => r.test.test(cmd));
  if (denyHits.length) {
    return {
      decision: "deny",
      risk: "high",
      reasons: denyHits.map((r) => r.reason),
      ruleIds: denyHits.map((r) => r.id),
    };
  }

  // 2) Gate — destructive/mutating but legitimate. Take the max risk that fires.
  const gateHits = compileRules(policy.rules, "gate").filter((r) => r.test.test(cmd));
  if (gateHits.length) {
    return {
      decision: "gate",
      risk: gateHits.reduce<Risk>((acc, r) => maxRisk(acc, r.risk), "low"),
      reasons: gateHits.map((r) => r.reason),
      ruleIds: gateHits.map((r) => r.id),
    };
  }

  // 3) Allow — only if certifiably read-only and free of risky composition.
  const allowLeaders = compileRules(policy.rules, "allow-leader");
  const segs = segments(cmd);
  const allAllowed =
    (!policy.unsafeCompositionBlocksAllow || !UNSAFE_COMPOSITION.test(cmd)) &&
    segs.length > 0 &&
    segs.every((s) => allowLeaders.some((r) => r.test.test(s)));
  if (allAllowed) {
    return { decision: "allow", risk: "low", reasons: ["read-only command"], ruleIds: ["allow-readonly"] };
  }

  // 4) Unknown — falls to the policy's default (today's shipped default: gate/medium).
  return {
    decision: policy.defaultDecision,
    risk: policy.defaultRisk,
    reasons: ["unrecognized command — needs review"],
    ruleIds: [`default-${policy.defaultDecision}`],
  };
}

/**
 * Re-validate at approve time: throws {@link CommandDeniedError} if policy would
 * never run this command, so a stray "approve" on a denied command is refused
 * server-side. Returns the verdict otherwise. (Defense in depth — the gate that
 * raised the HITL should already have caught it.)
 */
export function assertApprovable(command: string, policy: CommandPolicy = DEFAULT_COMMAND_POLICY): CommandVerdict {
  const verdict = classifyCommand(command, policy);
  if (verdict.decision === "deny") throw new CommandDeniedError(verdict, command);
  return verdict;
}

// ─── Context-aware blast-radius analysis ─────────────────────────────────────
// classifyCommand() judges a command by its OWN shape; blastRadiusFlags() judges
// it by WHERE it operates. A command writing outside the agent's private worktree
// has a higher blast radius than the same command running inside it — a mistake
// in a disposable worktree branch can be abandoned, while one outside it cannot.
//
// Returns an array of short flag strings (suitable for HitlItem.flags) that
// callers add to the gate and use to bump the risk floor. Returns [] when no
// extra context-driven risk is detected.

export interface BlastContext {
  /** Absolute path to the agent's git worktree root. When absent, all absolute
   *  paths found in the command are treated as outside-worktree. */
  worktreePath?: string;
}

// Matches absolute paths embedded in a command line.
const ABS_PATH_RE = /(?:^|[\s'"=:,])(\/([\w.-]+\/)*[\w.-]*)/g;

// System paths where writes are almost never intentional from an agent.
const SYSTEM_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/root", "/proc", "/sys", "/dev", "/boot", "/var", "/home"];

// Network-egress leaders not already covered by the pipe-to-shell deny rules.
// Matches curl/wget/fetch that do NOT immediately pipe into a shell (those are
// already a hard deny via DENY_RULES). Also flags ssh/scp/rsync/nc.
const EGRESS_RE = /\b(curl|wget|fetch|ssh|scp|rsync)\b|\bnc\s+/i;

/**
 * Returns blast-radius flags for a command given its runtime context.
 * Flags:
 *   "outside-worktree:<path>" — an absolute path in the command falls outside the
 *     agent's worktree (or is a known system path when no worktreePath is given).
 *   "network-egress:<tool>" — the command makes an outbound network connection.
 */
export function blastRadiusFlags(command: string, ctx: BlastContext = {}): string[] {
  const { worktreePath } = ctx;
  const wtRoot = worktreePath ? (worktreePath.endsWith("/") ? worktreePath : worktreePath + "/") : null;
  const flags: string[] = [];
  const seen = new Set<string>();

  // Absolute-path scan.
  let m: RegExpExecArray | null;
  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(command)) !== null) {
    const p = m[1];
    if (p === undefined) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    if (wtRoot && (p === worktreePath || p.startsWith(wtRoot))) continue; // inside worktree — safe
    const isSystem = SYSTEM_PREFIXES.some((sp) => p === sp || p.startsWith(sp + "/"));
    if (isSystem || wtRoot) {
      // Cap path length to keep flags readable.
      flags.push(`outside-worktree:${p.length > 60 ? p.slice(0, 60) + "…" : p}`);
    }
  }

  // Network egress.
  EGRESS_RE.lastIndex = 0;
  const eg = EGRESS_RE.exec(command);
  if (eg) {
    flags.push(`network-egress:${eg[1] ?? "nc"}`);
  }

  return flags;
}

// ─── Bounded execution ────────────────────────────────────────────────────────

export interface BoundedExecOptions {
  cwd: string;
  /** Hard wall-clock limit; SIGTERM then SIGKILL. Default SKYNET_CMD_TIMEOUT_MS or 120s. */
  timeoutMs?: number;
  /** Max bytes captured per stream before truncating. Default SKYNET_CMD_MAX_OUTPUT_BYTES or 1 MiB. */
  maxOutputBytes?: number;
  /** Explicit environment. Default: a scrubbed allowlist (PATH/HOME/LANG/…). */
  env?: NodeJS.ProcessEnv;
}

export interface BoundedExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR"];

/** The safe-baseline environment for any server-initiated command over
 *  untrusted (pre-merge, agent-branch) content — an allowlist, not a
 *  denylist over `process.env`: a denylist only drops names it happens to
 *  know about, so anything else the server process holds (a custom deploy
 *  token, a third-party key set for an unrelated integration) still leaks
 *  through. Exported so other server-initiated-command call sites (e.g. the
 *  live-preview / Fly-deploy install-build step in preview/worktree.ts) can
 *  share this exact baseline instead of re-deriving their own. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Run a command under hard limits. Never throws on a non-zero exit — inspect
 * `code`/`signal`/`timedOut`. Output past `maxOutputBytes` is dropped and
 * `truncated` is set. The environment is scrubbed to an allowlist unless `env`
 * is supplied; stdin is closed and stdio is never inherited.
 */
export function runBounded(command: string, opts: BoundedExecOptions): Promise<BoundedExecResult> {
  const timeoutMs = opts.timeoutMs ?? intFromEnv("SKYNET_CMD_TIMEOUT_MS", 120_000);
  const maxOutputBytes = opts.maxOutputBytes ?? intFromEnv("SKYNET_CMD_MAX_OUTPUT_BYTES", 1_000_000);
  const startedAt = Date.now();

  return new Promise<BoundedExecResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = (buf: string, chunk: Buffer): string => {
      if (buf.length >= maxOutputBytes) {
        truncated = true;
        return buf;
      }
      const next = buf + chunk.toString("utf8");
      if (next.length > maxOutputBytes) {
        truncated = true;
        return next.slice(0, maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (c: Buffer) => { stdout = cap(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = cap(stderr, c); });

    // Timeout: SIGTERM, then SIGKILL if it doesn't die promptly.
    const term = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(term);
      resolve({ code, signal, stdout, stderr, timedOut, truncated, durationMs: Date.now() - startedAt });
    };

    child.on("error", (err) => {
      stderr = cap(stderr, Buffer.from(`spawn error: ${err.message}`));
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}

/**
 * Classify then run: denies hard-blocked commands (throws {@link CommandDeniedError}),
 * otherwise executes under {@link runBounded}. Returns both the verdict and the
 * bounded result. Suitable for the merge-queue `checkCmd` path and any
 * server-initiated command. (For agent tool-use, classify at the gate instead —
 * the runner, not the server, executes the agent's command.)
 */
export async function safeExec(
  command: string,
  opts: BoundedExecOptions,
  policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
): Promise<{ verdict: CommandVerdict; result: BoundedExecResult }> {
  const verdict = assertApprovable(command, policy);
  const result = await runBounded(command, opts);
  return { verdict, result };
}
