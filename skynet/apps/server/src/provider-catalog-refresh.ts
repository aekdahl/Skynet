// ─── Model-catalog auto-refresh (Approach B) ────────────────────────────────
// Periodically fetches a maintained public model catalog and updates the Fleet
// picker's SUGGESTIONS, so newly-released models appear without a code edit. The
// mapping is pure + tested (provider-catalog.ts); this module owns only the I/O
// (fetch) and the schedule, and is entirely fail-safe: any error leaves the
// curated defaults in place (the fetch is a read-only GET of a public catalog —
// no keys or data leave the host, and it never blocks which models actually run).

import { mapExternalCatalog } from "./provider-catalog.js";
import { setModelOverrides } from "./store/providers.js";

/** Fetch + map the external catalog and install it as the discovered suggestions.
 *  Resolves to the number of discovered model ids (0 if none). Throws on a
 *  network / parse error so the caller can log it (state is left unchanged). */
export async function refreshModelCatalog(url: string): Promise<number> {
  const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const overrides = mapExternalCatalog(await res.json());
  setModelOverrides(overrides);
  return Object.values(overrides).reduce((n, ids) => n + (ids?.length ?? 0), 0);
}

/** Start the refresh loop: once on boot, then every `intervalMs` (floored at 1h
 *  to avoid hammering the source; disabled entirely when `intervalMs <= 0`).
 *  Best-effort — failures are logged and retried on the next tick. The timer is
 *  unref'd so it never keeps the process alive. */
export function startModelCatalogRefresh(
  url: string,
  intervalMs: number,
  log: (msg: string) => void,
): void {
  if (intervalMs <= 0) return;
  const tick = () =>
    refreshModelCatalog(url)
      .then((n) => log(`model catalog: ${n} model suggestion(s) refreshed from ${url}`))
      .catch((err) => log(`model catalog refresh failed (${(err as Error).message}) — keeping curated defaults`));
  void tick(); // once on boot
  setInterval(tick, Math.max(3_600_000, intervalMs)).unref();
}
