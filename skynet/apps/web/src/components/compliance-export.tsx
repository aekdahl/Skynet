import { useState } from "react";
import type { Project } from "@skynet/shared";
import { renderComplianceReportMarkdown } from "@skynet/shared";
import * as api from "../lib/client";

/** Trigger a browser download of in-memory content — no server round-trip
 *  beyond the report fetch itself, since the Markdown is rendered client-side
 *  from the already-fetched signed JSON (one canonical renderer, shared with
 *  the server's test suite via packages/shared/src/compliance.ts). */
function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** One-click, signed "AI change report" export (ROADMAP: Compliance evidence
 *  pack) — scope to a project and/or a date range, or leave both unset for
 *  the whole workspace. Every AI-authored change (an approved diff/merge)
 *  in scope, who approved it and why, cryptographically signed so an
 *  auditor can verify the exported document wasn't altered afterward. */
export function ComplianceReportExport({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(""); // "" = entire workspace
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"json" | "md" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const generate = async (format: "json" | "md") => {
    setBusy(format);
    setErr(null);
    try {
      const signed = await api.fetchComplianceReport({
        projectId: projectId || null,
        from: from ? new Date(from).getTime() : null,
        // Inclusive end-of-day, so picking the same start/end date covers that whole day.
        to: to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 - 1 : null,
      });
      const stamp = new Date(signed.report.generatedAt).toISOString().slice(0, 10);
      if (format === "json") {
        downloadFile(`skynet-compliance-report-${stamp}.json`, JSON.stringify(signed, null, 2), "application/json");
      } else {
        downloadFile(`skynet-compliance-report-${stamp}.md`, renderComplianceReportMarkdown(signed), "text/markdown");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't generate the report.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="compliance-export">
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Export compliance report
      </button>
      {open && (
        <div className="compliance-export-panel">
          <p className="compliance-export-hint">
            Every AI-authored change approved in scope — who approved it, why, and the risk
            classification at the time. Signed, so an auditor can verify it wasn't altered after export.
          </p>
          <div className="compliance-export-row">
            <label>
              Scope
              <select className="settings-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Entire workspace</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input className="settings-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input className="settings-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {err && <p className="compliance-export-err">{err}</p>}
          <div className="compliance-export-actions">
            <button className="btn btn-primary btn-sm" disabled={busy != null} onClick={() => void generate("md")}>
              {busy === "md" ? "Generating…" : "Download Markdown"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy != null} onClick={() => void generate("json")}>
              {busy === "json" ? "Generating…" : "Download JSON"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
