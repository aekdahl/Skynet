// ─── Which key does a project's own work bill to? ──────────────────────────
// `Project.enabledRunnerCredentialIds` restricts which keys a project may run
// on. That restriction was enforced where RUNNERS are acquired — so a project's
// runs and reviews honoured it — but a whole class of side calls resolved
// `secretService.resolve(ws, "claude")` and billed the workspace's default
// Anthropic key regardless: triage clarifications, brief grounding, crystallize,
// decompose, board organisation, context condensing, backlog replenishment.
//
// Two things were wrong with that, and only one of them is money:
//   • A project pinned to a cheap compatible endpoint still paid Anthropic for
//     every one of those calls — the endpoint work moved the runs and left the
//     side calls behind.
//   • "This project may only use key X" simply wasn't true, which is a
//     governance claim, not a billing preference.
//
// Resolved in ONE place so the next side call someone adds inherits the rule
// instead of quietly re-introducing the gap — which is exactly how the gap got
// there (the credential was threaded through ~20 call sites, and the ones added
// afterwards missed it).

import type { Store } from "./store/store.js";
import { secretService } from "./secrets/index.js";
import { ratesFor, type ModelRates } from "@skynet/shared";

/** Everything a side call needs to bill the right vendor. `baseUrl` matters as
 *  much as the key: a credential can name a Claude-compatible endpoint, and
 *  sending its key to Anthropic would authenticate nothing. */
export interface ProjectCredential {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  rates: ModelRates | null;
  /** The credential id actually used — for logs and tests. */
  credentialId: string;
}

/**
 * The credential a project's own LLM side calls should use.
 *
 * `enabledRunnerCredentialIds` is an ALLOWLIST, so any member is legitimate by
 * definition; the first is chosen because an arbitrary-but-deterministic pick
 * beats a nondeterministic one when an operator is reading a bill and asking
 * which key paid for what. Empty (the default, "any key") or no project falls
 * back to the provider's default credential — the previous behaviour, which is
 * correct when nothing was restricted.
 */
export async function projectCredential(
  store: Store,
  ws: string,
  projectId: string | null | undefined,
  model: string,
  provider = "claude",
): Promise<ProjectCredential> {
  let credentialId = provider;
  if (projectId) {
    const project = await store.getProject(projectId).catch(() => null);
    const allowed = project?.enabledRunnerCredentialIds ?? [];
    if (allowed.length > 0) credentialId = allowed[0]!;
  }
  const apiKey = (await secretService.resolve(ws, credentialId).catch(() => undefined)) ?? undefined;
  const baseUrl = await secretService.resolveEndpoint(ws, credentialId).catch(() => undefined);
  return { apiKey, baseUrl, rates: ratesFor(baseUrl, model), credentialId };
}
