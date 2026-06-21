// ─── Preview providers ────────────────────────────────────────────────────
// Three backends behind one interface (Architecture Brief §07 — preview is
// pluggable). `off` is the default and yields nothing renderable. `artifact`
// serves a built per-agent bundle from this server's sandboxed /preview route.
// `deploy` formats an external render/deploy-service URL from a template.

import { previewConfig } from "./config.js";
import type { PreviewInput, PreviewProvider, PreviewResult } from "./types.js";

// Keywords that hint at a renderable (UI) delivery, for the opt-in heuristic.
// Deliberately excludes ambiguous terms like "token" (design tokens are visual,
// auth tokens are not) — the heuristic is off unless explicitly enabled.
const VISUAL_HINTS =
  /\b(ui|ux|frontend|front-end|dashboard|onboarding|landing page|marketing site|web app|design system|storefront)\b/i;

/**
 * Does this project render a UI we can preview? Authoritative signals first
 * (the seed/agent flag, then an explicit project allowlist); the keyword
 * heuristic only runs when SKYNET_PREVIEW_VISUAL_HEURISTIC=true.
 */
export function isVisual(input: PreviewInput): boolean {
  if (input.seedVisual) return true;
  if (previewConfig.visualProjects.includes(input.projectId)) return true;
  if (previewConfig.visualHeuristic) return VISUAL_HINTS.test(`${input.projectName} ${input.projectGoal}`);
  return false;
}

const NULL_RESULT: PreviewResult = { visual: false, previewUrl: null };

/** Default: nothing renderable — the SPA folds the preview panel away. */
export const offProvider: PreviewProvider = {
  id: "off",
  resolve: () => NULL_RESULT,
};

/** Serve a built per-agent artifact from this server's sandboxed route. */
export const artifactProvider: PreviewProvider = {
  id: "artifact",
  resolve: (input) => {
    if (!isVisual(input)) return NULL_RESULT;
    // URL is reserved at branch-creation time and stable; the route serves a
    // "building…" page until the artifact dir is populated by a build step.
    return { visual: true, previewUrl: `${previewConfig.baseUrl}/preview/${encodeURIComponent(input.agentId)}/` };
  },
};

/** Format an external deploy/render-service URL from a template. */
export const deployProvider: PreviewProvider = {
  id: "deploy",
  resolve: (input) => {
    if (!isVisual(input)) return NULL_RESULT;
    const tmpl = previewConfig.urlTemplate;
    if (!tmpl) return { visual: true, previewUrl: null };
    const branchSlug = input.branch.split("/").pop() ?? input.branch;
    const url = tmpl
      .replaceAll("{agentId}", encodeURIComponent(input.agentId))
      .replaceAll("{branch}", encodeURIComponent(branchSlug))
      .replaceAll("{workspace}", encodeURIComponent(input.workspaceId))
      .replaceAll("{project}", encodeURIComponent(input.projectId));
    return { visual: true, previewUrl: url };
  },
};

export function providerFor(mode: string): PreviewProvider {
  switch (mode) {
    case "artifact":
      return artifactProvider;
    case "deploy":
      return deployProvider;
    default:
      return offProvider;
  }
}
