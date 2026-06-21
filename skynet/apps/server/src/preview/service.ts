// ─── Preview service ──────────────────────────────────────────────────────
// Resolves {visual, previewUrl} for an agent's working branch via the
// configured provider. The orchestrator calls resolve() at agent-creation time
// (so the values ride the agent.started snapshot), and backfillPreviews() seeds
// existing agents at boot.

import { previewConfig } from "./config.js";
import { providerFor } from "./providers.js";
import type { PreviewInput, PreviewProvider, PreviewResult } from "./types.js";

export class PreviewService {
  private provider: PreviewProvider;
  constructor(mode: string = previewConfig.mode) {
    this.provider = providerFor(mode);
  }

  get mode(): string {
    return this.provider.id;
  }

  /** True once a provider other than `off` is configured. */
  get enabled(): boolean {
    return this.provider.id !== "off";
  }

  async resolve(input: PreviewInput): Promise<PreviewResult> {
    return this.provider.resolve(input);
  }
}

/** Process-wide singleton, configured from the environment. */
export const previewService = new PreviewService();
