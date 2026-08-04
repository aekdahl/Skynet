// The audit fetch used AuditRecord.array().parse() — all-or-nothing zod parse.
// One legacy row from an older schema (or a half-applied migration) blew up the
// whole list and blanked the audit page, so every approval looked lost. The fix
// parses each row independently and drops invalid ones with a warning; the good
// rows still show. These lock that in.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchAudit } from "../apps/web/src/lib/client.js";

const goodRow = {
  workspaceId: "cyberdyne",
  hitlId: "q-1",
  runId: "run-1",
  action: "approve",
  operatorId: "op-1",
  at: 100,
  payload: { kind: "approval" },
};
// Missing required `runId` / `operatorId` — an older AuditRecord shape.
const legacyRow = { workspaceId: "cyberdyne", hitlId: "q-legacy", action: "approve", at: 50 };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn());
  // client.ts reads sessionStorage for the workspace token; a jsdom-free node
  // env has neither, so stub it out to a no-op object.
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => undefined });
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
});

function mockAuditResponse(rows: unknown): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  } as unknown as Response);
}

describe("fetchAudit — per-record tolerance", () => {
  it("returns valid rows and DROPS invalid ones (never throws, never blanks the list)", async () => {
    mockAuditResponse([goodRow, legacyRow]);
    const rows = await fetchAudit();
    const ids = rows.map((r) => r.hitlId);
    expect(ids).toContain("q-1");
    expect(ids).not.toContain("q-legacy");
    // The drop is logged so it's diagnosable, not silent.
    expect(warn).toHaveBeenCalled();
    expect((warn.mock.calls[0]?.[0] ?? "") as string).toMatch(/q-legacy/);
  });

  it("returns [] when the response isn't an array (never crashes the audit view)", async () => {
    mockAuditResponse({ oops: "not an array" });
    await expect(fetchAudit()).resolves.toEqual([]);
  });

  it("returns [] when ALL rows are invalid — the page renders empty, not broken", async () => {
    mockAuditResponse([legacyRow, { hitlId: "another" }]);
    const rows = await fetchAudit();
    expect(rows).toEqual([]);
    // Both drops logged.
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
