// ─── Compliance evidence pack ───────────────────────────────────────────────
// One-click, signed "AI change report" for auditors (ROADMAP: Compliance
// evidence pack, EU AI Act tailwind). Wraps report.ts (build from the existing
// audit trail) + signing.ts (Ed25519 sign/verify) into the one entrypoint
// Operations calls.

import type { ComplianceReport, GenerateComplianceReportRequest, SignedComplianceReport } from "@skynet/shared";
import type { Store } from "../store/store.js";
import { buildComplianceReport } from "./report.js";
import { signComplianceReport, signingKeyFingerprint, verifyComplianceReport } from "./signing.js";

export type { ComplianceReport, SignedComplianceReport };
export { verifyComplianceReport, signingKeyFingerprint };

export async function generateSignedComplianceReport(
  store: Store,
  workspaceId: string,
  generatedBy: string,
  scope: GenerateComplianceReportRequest,
): Promise<SignedComplianceReport> {
  const report = await buildComplianceReport(store, { workspaceId, generatedBy, scope });
  return signComplianceReport(report);
}
