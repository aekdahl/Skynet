// ─── Compliance evidence pack — Markdown rendering ─────────────────────────
// Turns a SignedComplianceReport into a readable Markdown document — the
// "one-click" human-facing deliverable. Pure formatting over already-signed
// data (no hashing/signing here, that's server-only — see
// apps/server/src/compliance/signing.ts); safe to run in the browser so the
// web client can render + download without a second server round-trip.

import type { ComplianceReportEntry, SignedComplianceReport } from "./contracts.js";

const APPROVER_LABEL: Record<ComplianceReportEntry["approverType"], string> = {
  human: "Human operator",
  policy: "Auto-approved (standing policy)",
  "agent-review": "Auto-approved (fleet agent review)",
};

function fmtDate(at: number): string {
  return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render a signed compliance report as a self-contained Markdown document,
 *  including the verification footer an auditor needs to check authenticity
 *  offline (the algorithm, content hash, signature, and public key are all
 *  embedded — no server access required to verify). */
export function renderComplianceReportMarkdown(signed: SignedComplianceReport): string {
  const { report } = signed;
  const lines: string[] = [];
  const scopeLabel = report.scope.runId
    ? `Run ${report.scope.runId}`
    : report.scope.projectName
      ? `Project "${report.scope.projectName}"`
      : report.scope.projectId
        ? `Project ${report.scope.projectId}`
        : "Entire workspace";
  const rangeLabel =
    report.scope.from != null || report.scope.to != null
      ? `${report.scope.from != null ? fmtDate(report.scope.from) : "the beginning"} → ${report.scope.to != null ? fmtDate(report.scope.to) : "now"}`
      : "all time";

  lines.push(`# AI Change Report — Compliance Evidence Pack`);
  lines.push("");
  lines.push(`**Scope:** ${scopeLabel}`);
  lines.push(`**Period:** ${rangeLabel}`);
  lines.push(`**Generated:** ${fmtDate(report.generatedAt)} by \`${report.generatedBy}\``);
  lines.push(`**Report id:** \`${report.id}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- **${report.summary.totalChanges}** AI-authored change${report.summary.totalChanges === 1 ? "" : "s"} in scope`);
  lines.push(`  - ${report.summary.humanApproved} approved by a human operator`);
  lines.push(`  - ${report.summary.policyAutoApproved} auto-approved by a standing approval policy`);
  lines.push(`  - ${report.summary.agentReviewApproved} auto-approved after a fleet agent's review`);
  lines.push(`- **${report.summary.highRisk}** classified high-risk at decision time`);
  if (report.summary.earliestDecisionAt != null && report.summary.latestDecisionAt != null) {
    lines.push(`- Decisions span ${fmtDate(report.summary.earliestDecisionAt)} → ${fmtDate(report.summary.latestDecisionAt)}`);
  }
  lines.push("");

  if (report.entries.length === 0) {
    lines.push(`_No AI-authored changes were approved in this scope._`);
  } else {
    lines.push(`## Changes`);
    lines.push("");
    lines.push(`| When | Project | Change | Risk | Files | Approved by | Reason |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    for (const e of report.entries) {
      const approver =
        e.approverType === "human"
          ? `${esc(e.approvedBy)}`
          : `${APPROVER_LABEL[e.approverType]}${e.policyDetail ? ` — \`${esc(e.policyDetail)}\`` : ""}`;
      const change = `${esc(e.title)} (\`${esc(e.branch ?? e.runId)}\`)`;
      const diffLabel = e.diffAdd != null && e.diffDel != null ? `${e.diffAdd}+/${e.diffDel}−` : "—";
      lines.push(
        `| ${fmtDate(e.decidedAt)} | ${esc(e.projectName ?? e.projectId ?? "—")} | ${change} | ${e.risk ?? "—"} | ${diffLabel} (${e.diffFiles.length}) | ${approver} | ${e.reason ? esc(e.reason) : "—"} |`,
      );
    }
  }

  lines.push("");
  lines.push(`## Verification`);
  lines.push("");
  lines.push(
    `This report is cryptographically signed by the Skynet installation that generated it. To verify it ` +
      `has not been altered since export: recompute the SHA-256 digest of the canonical (recursively ` +
      `key-sorted) JSON of the \`report\` field below and confirm it equals \`contentHash\`, then verify ` +
      `\`signature\` (Ed25519, base64) against \`contentHash\` using \`publicKey\` (base64 SPKI). This proves ` +
      `the report content is unaltered and was signed by whoever holds the private key for \`publicKey\` — ` +
      `for stronger assurance than trust-on-first-use, compare \`publicKey\` against a fingerprint the ` +
      `operator has published separately.`,
  );
  lines.push("");
  lines.push(`- **Algorithm:** ${signed.algorithm}`);
  lines.push(`- **Content hash (SHA-256):** \`${signed.contentHash}\``);
  lines.push(`- **Signature (base64):** \`${signed.signature}\``);
  lines.push(`- **Public key (base64 SPKI):** \`${signed.publicKey}\``);
  lines.push("");

  return lines.join("\n");
}
