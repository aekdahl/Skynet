// ─── Preview types ────────────────────────────────────────────────────────
// The seam between the orchestrator/boot wiring and a preview backend. A
// provider takes what we know about an agent's working branch and returns
// whether the delivery is renderable plus a sandboxed URL to embed.

export interface PreviewInput {
  workspaceId: string;
  projectId: string;
  projectName: string;
  projectGoal: string;
  agentId: string;
  branch: string;
  /** The agent's own visual flag (e.g. from seed) — providers may honour it. */
  seedVisual: boolean;
}

export interface PreviewResult {
  /** Has a renderable delivery — drives the SPA's fold-away behaviour. */
  visual: boolean;
  /** Sandboxed URL the SPA iframes, or null when nothing to show. */
  previewUrl: string | null;
}

/** A preview backend: deploy URL, built artifact, or render service. */
export interface PreviewProvider {
  readonly id: string;
  resolve(input: PreviewInput): PreviewResult | Promise<PreviewResult>;
}
