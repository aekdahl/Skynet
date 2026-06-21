// ─── Preview config ───────────────────────────────────────────────────────
// W5 live-preview pipeline configuration, read from the environment so the
// feature is fully opt-in. The default (`PREVIEW=off`) leaves agents with
// previewUrl=null exactly as before — the SPA folds the panel away — so the
// `RUNNER=mock STORE=memory pnpm dev` path is unchanged.
//
//   PREVIEW=off | artifact | deploy        (default: off)
//   SKYNET_PREVIEW_BASE_URL                 public origin previews are served from
//                                           (default http://localhost:$PORT)
//   SKYNET_PREVIEW_ROOT                     artifact root dir (artifact provider)
//   SKYNET_PREVIEW_URL_TEMPLATE             URL template (deploy provider), with
//                                           {agentId} {branch} {workspace} {project}
//   SKYNET_PREVIEW_VISUAL_PROJECTS          comma list of project ids to force-visual
//   SKYNET_PREVIEW_FRAME_ANCESTORS          CSP frame-ancestors (default *)

import { tmpdir } from "node:os";
import { join } from "node:path";

export type PreviewMode = "off" | "artifact" | "deploy";

const port = Number(process.env.PORT ?? 8080);

function commaList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const previewConfig = {
  mode: ((process.env.PREVIEW ?? "off").toLowerCase() as PreviewMode) || "off",
  // Absolute origin the SPA points its iframe at. Defaults to this server.
  baseUrl: (process.env.SKYNET_PREVIEW_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  // Where per-agent built artifacts live (artifact provider serves these).
  artifactRoot: process.env.SKYNET_PREVIEW_ROOT || join(tmpdir(), "skynet-previews"),
  // External render/deploy service URL template (deploy provider).
  urlTemplate: process.env.SKYNET_PREVIEW_URL_TEMPLATE || "",
  // Projects to treat as visual regardless of heuristic / seed flag.
  visualProjects: commaList(process.env.SKYNET_PREVIEW_VISUAL_PROJECTS),
  // Opt-in keyword heuristic for marking unflagged projects visual. Off by
  // default — it can't tell "design tokens" (visual) from "auth tokens" (not).
  visualHeuristic: process.env.SKYNET_PREVIEW_VISUAL_HEURISTIC === "true",
  // Who may embed a preview in an <iframe>. `*` suits dev (SPA on another port).
  frameAncestors: process.env.SKYNET_PREVIEW_FRAME_ANCESTORS || "*",

  // ── build pipeline (artifact provider) ──────────────────────────────────
  // Per-agent branch source, in priority order: a worktree of the integration
  // repo (SKYNET_INTEGRATION_REPO) → <SOURCE_ROOT>/<agentId> → SOURCE_DIR.
  sourceRoot: process.env.SKYNET_PREVIEW_SOURCE_ROOT || "",
  sourceDir: process.env.SKYNET_PREVIEW_SOURCE_DIR || "",
  // Optional install + build commands run in the source dir. With no build
  // command the source is published as static files (zero-config, nothing runs).
  installCmd: process.env.SKYNET_PREVIEW_INSTALL_CMD || "",
  buildCmd: process.env.SKYNET_PREVIEW_BUILD_CMD || "",
  // Built output dir (relative to source) published when a build command runs.
  outputDir: process.env.SKYNET_PREVIEW_OUTPUT_DIR || "dist",
  // Per-build wall-clock cap before the build is killed and marked failed.
  buildTimeoutMs: Number(process.env.SKYNET_PREVIEW_BUILD_TIMEOUT_MS ?? 120_000),
};

export type PreviewConfig = typeof previewConfig;
