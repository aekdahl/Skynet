// ─── Claude-compatible endpoint catalog ────────────────────────────────────
// Vendors that speak the Anthropic wire protocol, so the Claude Agent SDK can
// drive them unchanged — keeping the FULL agent loop (tool gating, HITL,
// escalation, resume) that no CLI-backed runner has. See the ⚠️ CRITICAL note
// in ROADMAP.md before adding a runner instead of an endpoint.
//
// Two jobs:
//   1. Presets, so an operator picks a vendor instead of typing a URL. These
//      URLs are genuinely error-prone — Z.ai doubles the `api` segment, and
//      MiniMax splits .io/.com by region.
//   2. RATES, so spend is real. The SDK prices a run from Claude Code's own
//      Anthropic price table, which is meaningless once the tokens were served
//      by someone else — the dollar figure would be either zero (unknown model
//      id) or Anthropic's rate for a model that isn't Anthropic's. Cost is the
//      whole reason to be on a cheap endpoint, so it has to be measured, not
//      assumed. Token counts are unaffected; only the USD conversion is.
//
// ADVISORY, exactly like DEFAULT_PROVIDERS (see providers.ts): a custom
// endpoint and an unlisted model id are always allowed. A stale entry here
// never blocks anything — it just means no preset and no local pricing.
//
// Rates are US dollars per MILLION tokens, list price, captured 2026-08-27.
// Provenance is per-vendor below; vendors change prices without notice, so
// treat these as a good estimate, not an invoice. `null` cache rates mean the
// vendor publishes none — that tier is then priced at the input rate, which
// over-states rather than flatters the cheap option.

/** Per-million-token prices for one model. */
export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache READS. Dominates agent workloads — most input is replayed context. */
  cacheReadPerMTok: number | null;
  /** Cache WRITES. Null → priced at the input rate. */
  cacheWritePerMTok: number | null;
}

export interface CompatibleModel {
  id: string;
  /** Short note for the picker — what this model is FOR. */
  note?: string;
  rates: ModelRates | null;
}

export interface CompatibleVendor {
  id: string;
  name: string;
  /** Value for ANTHROPIC_BASE_URL. */
  baseUrl: string;
  docsUrl: string;
  models: CompatibleModel[];
  /** Known compatibility gaps — shown to the operator, not silently swallowed. */
  caveat?: string;
}

const r = (
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadPerMTok: number | null = null,
  cacheWritePerMTok: number | null = null,
): ModelRates => ({ inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok });

/** Anthropic's own list prices — the baseline every alternative is judged against. */
export const ANTHROPIC_RATES: Record<string, ModelRates> = {
  opus: r(15, 75, 1.5, 18.75),
  sonnet: r(3, 15, 0.3, 3.75),
  haiku: r(1, 5, 0.1, 1.25),
};

export const COMPATIBLE_VENDORS: CompatibleVendor[] = [
  {
    // Verified against DeepSeek's own docs (api-docs.deepseek.com), 2026-08-27.
    // Prices below are PEAK; DeepSeek bills off-peak at half, so real spend
    // tends to land under what this reports.
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api/",
    caveat:
      "Ignores MCP fields — a run on this endpoint has no browser tools. Keep browser-driven review on Anthropic. Also ignores anthropic-beta, top_k and thinking budget_tokens. Off-peak hours bill at half these rates.",
    models: [
      { id: "deepseek-v4-flash", note: "cheapest — routine coding", rates: r(0.44, 1.32, 0.014) },
      { id: "deepseek-v4-pro", note: "stronger reasoning", rates: r(1.32, 3.96, 0.044) },
    ],
  },
  {
    // Verified against platform.kimi.ai pricing pages, 2026-08-27.
    id: "moonshot",
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    docsUrl: "https://platform.kimi.ai/docs",
    caveat:
      "The /anthropic surface works but Moonshot publishes no contract for it, so it can change without notice. Note kimi-k3 is priced at Anthropic Sonnet parity — it is not a saving; kimi-k2.7-code is.",
    models: [
      { id: "kimi-k2.7-code", note: "cheapest — coding-specialised", rates: r(0.95, 4.0, 0.19) },
      { id: "kimi-k2.7-code-highspeed", note: "faster, 2x the price", rates: r(1.9, 8.0, 0.38) },
      { id: "kimi-k3", note: "flagship, 1M ctx — Sonnet parity, no saving", rates: r(3.0, 15.0, 0.3) },
    ],
  },
  {
    // Base URL + models verified against docs.z.ai/devpack/tool/claude,
    // 2026-08-27; GLM-5.3 rates from Z.ai's published API pricing.
    id: "zai",
    name: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/anthropic",
    docsUrl: "https://docs.z.ai/devpack/tool/claude",
    models: [
      { id: "glm-5.3", note: "coding flagship", rates: r(1.4, 4.4, 0.26) },
      { id: "glm-5.3-flash", note: "faster tier — rates unpublished", rates: null },
    ],
  },
  {
    // Endpoint + model ids from MiniMax's platform docs, 2026-08-27. Rates are
    // the least corroborated set here — treat as indicative.
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
    caveat:
      "Its compatibility layer has reported a 200K context window for a 1M-context model, which makes Claude Code compact early and burn tokens it didn't need to. Rates here are indicative rather than vendor-confirmed. Users outside .io regions use https://api.minimaxi.com/anthropic.",
    models: [
      { id: "minimax-m2.7", note: "cheapest", rates: r(0.3, 1.2, 0.059) },
      { id: "minimax-m2.7-highspeed", note: "faster tier", rates: r(0.6, 2.4, null) },
    ],
  },
];

/** Trailing slashes and case shouldn't decide whether two URLs are the same. */
const canon = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

/** The catalogued vendor for an endpoint, or undefined for a custom one. */
export function vendorForBaseUrl(baseUrl: string | null | undefined): CompatibleVendor | undefined {
  if (!baseUrl) return undefined;
  const want = canon(baseUrl);
  return COMPATIBLE_VENDORS.find((v) => canon(v.baseUrl) === want);
}

/**
 * A short label for "what is this run actually talking to" — the string the UI
 * puts on an agent so a non-Anthropic run is never mistaken for a Claude one.
 * Null means Anthropic's own API (the default; nothing to flag).
 */
export function endpointLabel(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const vendor = vendorForBaseUrl(baseUrl);
  if (vendor) return vendor.name;
  // Custom endpoint: the host is the recognisable part. Parsed by hand rather
  // than with URL(), since this module is shared with the browser bundle and
  // stays dependency- and lib-free.
  const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(baseUrl.trim());
  return host?.[1] ?? baseUrl;
}

/**
 * Published rates for a (endpoint, model) pair, or null when we can't price it
 * — an unlisted vendor, an unlisted model, or a tier the vendor doesn't
 * publish. Null must leave the SDK's own figure alone rather than invent one:
 * a made-up cost is worse than an admitted gap.
 *
 * Model matching is prefix-based so a dated or suffixed id (`glm-5.3-0814`)
 * still prices, and the LONGEST match wins so `kimi-k2.7-code-highspeed` never
 * gets billed at `kimi-k2.7-code`'s cheaper rate.
 */
export function ratesFor(baseUrl: string | null | undefined, model: string): ModelRates | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (!baseUrl) {
    const family = Object.keys(ANTHROPIC_RATES).find((f) => id.includes(f));
    return family ? ANTHROPIC_RATES[family]! : null;
  }
  const vendor = vendorForBaseUrl(baseUrl);
  if (!vendor) return null;
  // Longest match wins across ALL models, priced or not. Filtering to priced
  // ones first would let an unpriced variant fall through to its shorter
  // sibling's rate — `glm-5.3-flash` billed as `glm-5.3` — which is the exact
  // failure this function exists to avoid: a confident number for a model whose
  // price we don't actually know. Best match with no rates → null.
  const best = vendor.models
    .filter((m) => id.startsWith(m.id.toLowerCase()))
    .sort((a, b) => b.id.length - a.id.length)[0];
  return best?.rates ?? null;
}

/**
 * PURE: price a metered run from published rates.
 *
 * Cache tiers are priced separately on purpose. An agent workload is mostly
 * REPLAYED context — cache reads run an order of magnitude below fresh input,
 * and folding them together would overstate a cheap endpoint badly enough to
 * hide the very saving this exists to measure.
 */
export function priceUsage(
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  rates: ModelRates,
): number {
  const per = (n: number, rate: number) => (n / 1_000_000) * rate;
  return (
    per(tokens.inputTokens, rates.inputPerMTok) +
    per(tokens.outputTokens, rates.outputPerMTok) +
    per(tokens.cacheReadTokens, rates.cacheReadPerMTok ?? rates.inputPerMTok) +
    per(tokens.cacheWriteTokens, rates.cacheWritePerMTok ?? rates.inputPerMTok)
  );
}
