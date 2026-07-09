// Small read-after-write settle helper for the in-app suites (acceptance +
// simulation). Right after a write, a slow client or in-flight refetch can
// return a snapshot that doesn't yet reflect it, producing a false negative on
// the very next read. `settle` re-fetches a bounded number of times until the
// expected condition holds, then returns the latest snapshot regardless — so a
// genuinely-missing entity still fails (after the retries), but transient lag
// doesn't. The server write itself is already awaited; this only guards the
// observability lag on the following read.

import * as api from "./client";
import type { Snapshot } from "@skynet/shared";

export async function settle(
  ready: (s: Snapshot) => boolean,
  tries = 6,
  delayMs = 150,
): Promise<Snapshot> {
  let s = await api.fetchSnapshot();
  for (let n = 0; n < tries && !ready(s); n++) {
    await new Promise((r) => setTimeout(r, delayMs));
    s = await api.fetchSnapshot();
  }
  return s;
}
