// ─── Preview module (W5) ──────────────────────────────────────────────────
// Live-preview pipeline: turns an agent's working branch into a sandboxed,
// embeddable preview URL + the `visual` fold-away flag. Opt-in via PREVIEW env.

export * from "./types.js";
export { previewConfig } from "./config.js";
export { isVisual } from "./providers.js";
export { PreviewService, previewService } from "./service.js";
export { registerPreview } from "./route.js";
export { backfillPreviews } from "./backfill.js";
export { PreviewBuilder, previewBuilder } from "./builder.js";
export { kickoffPreviewBuilds } from "./kickoff.js";
