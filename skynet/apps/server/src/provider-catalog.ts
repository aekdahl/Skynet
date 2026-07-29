// ─── External model-catalog mapping (auto-refresh, Approach B) ──────────────
// Maps a maintained external model catalog (models.dev shape — a top-level object
// keyed by vendor, each with a `models` map keyed by model id) into per-Skynet-
// provider model-id lists, so the Fleet picker's SUGGESTIONS stay current without
// hand-editing DEFAULT_PROVIDERS. Pure + defensive: unknown/garbage input yields
// {} (the caller falls back to the curated list). This only affects suggestions —
// validation is advisory (see @skynet/shared providers.ts), so nothing here can
// block or change which models actually run.

import type { ProviderId } from "@skynet/shared";

/** For each Skynet provider we can auto-discover, which external vendor to read
 *  and which of its model ids are relevant (the vendors' catalogs include models
 *  the corresponding CLI/SDK can't run — embeddings, image, tts — so we keep only
 *  the plausible coding models by id shape). Providers absent here (cursor,
 *  copilot, hermes) keep their curated list. */
const SOURCES: Partial<Record<ProviderId, { vendor: string; keep: RegExp }>> = {
  claude: { vendor: "anthropic", keep: /^claude-/ },
  codex: { vendor: "openai", keep: /^(gpt-|o\d|codex)/ },
  gemini: { vendor: "google", keep: /^gemini-/ },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Newest-first by release_date/last_updated when present (ISO dates sort
 *  lexically); entries without a date sort last, preserving input order. */
function byNewest(models: Record<string, unknown>): (a: string, b: string) => number {
  const date = (id: string): string => {
    const m = models[id];
    if (!isObj(m)) return "";
    return (typeof m.release_date === "string" && m.release_date) || (typeof m.last_updated === "string" && m.last_updated) || "";
  };
  return (a, b) => date(b).localeCompare(date(a));
}

/**
 * Map a fetched external catalog to `{ providerId: [modelId, …] }`. Keeps only
 * ids matching each provider's `keep` shape, drops any model explicitly flagged
 * `tool_call: false`, and orders newest-first. Never throws — bad input → {}.
 */
export function mapExternalCatalog(raw: unknown): Partial<Record<ProviderId, string[]>> {
  const out: Partial<Record<ProviderId, string[]>> = {};
  if (!isObj(raw)) return out;
  for (const [pid, src] of Object.entries(SOURCES) as [ProviderId, { vendor: string; keep: RegExp }][]) {
    const vendor = raw[src.vendor];
    const models = isObj(vendor) ? vendor.models : undefined;
    if (!isObj(models)) continue;
    const ids = Object.keys(models)
      .filter((id) => src.keep.test(id))
      .filter((id) => {
        const m = models[id];
        return !(isObj(m) && m.tool_call === false); // drop non-tool-calling models when flagged
      })
      .sort(byNewest(models));
    if (ids.length > 0) out[pid] = ids;
  }
  return out;
}

/**
 * Merge auto-discovered model ids over a provider's curated list: curated first
 * (the friendly one-click defaults stay on top), then discovered ids, deduped and
 * capped so the picker never balloons. Pure.
 */
export function mergeModels(curated: string[], discovered: string[] | undefined, cap = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...curated, ...(discovered ?? [])]) {
    const t = (m ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
