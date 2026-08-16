// ─── Fly deploy descriptor + config resolution ─────────────────────────────
// PURE functions only (no I/O, no network) — everything here is unit-tested
// without flyctl or a real Fly account. Reuses the EXISTING `.skynet/preview.json`
// descriptor shape (docs/live-preview.md: `{ kind, install, build, dev,
// outputDir, port, healthPath }`) rather than inventing a second format —
// `install`/`build`/`outputDir` were declared for Phase 1 but unused until this
// feature; a new `fly` sub-block carries only what's genuinely Fly-specific
// (app name, region, VM sizing). See docs/live-preview.md §"Deploy to Fly.io".

import { createHash } from "node:crypto";

/** The optional `fly` sub-block of `.skynet/preview.json`. Every field is an
 *  operator override; all have safe, small/free-tier defaults (see
 *  resolveFlyConfig) so a bare `{}` (or an absent block) never surprises
 *  anyone with cost. */
export interface FlyDescriptor {
  /** Explicit Fly app name. Overrides derivation — must already be globally
   *  unique on Fly, or the deploy fails with a clear "name taken" error. */
  app?: string;
  region?: string;
  /** A `flyctl` VM size preset, e.g. "shared-cpu-1x" (the smallest/cheapest). */
  size?: string;
  /** VM memory, e.g. "256mb". */
  memory?: string;
  /** Fly organization slug. Required (non-interactively) whenever the token's
   *  account belongs to more than one org — flyctl otherwise prompts
   *  interactively, which would hang a spawned, non-TTY deploy. Omit for a
   *  single-org (personal) account. */
  org?: string;
}

export const FLY_DEFAULT_REGION = "iad";
export const FLY_DEFAULT_SIZE = "shared-cpu-1x";
export const FLY_DEFAULT_MEMORY = "256mb";

export interface ResolvedFlyConfig {
  appName: string;
  region: string;
  size: string;
  memory: string;
  org: string | null;
  /** Present when the descriptor declares a `build` command — the STATIC-SITE
   *  path: build locally (reusing the same worktree/deps as the local
   *  preview), then ship a minimal static-file image. Reused verbatim from the
   *  existing (Phase 1, previously-unused) descriptor fields. */
  buildCmd: string | null;
  /** Where the static build's output lands, relative to the worktree root.
   *  Required (and defaulted) whenever `buildCmd` is set. */
  outputDir: string;
}

/** Fly app names: lowercase letters, digits, dashes; must start with a letter;
 *  no leading/trailing/doubled dashes; kept comfortably under Fly's ~63-char
 *  cap so a collision suffix always fits. */
export function slugifyAppName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) return "app"; // pure punctuation/empty → no fragment to prefix
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

/** A short, DETERMINISTIC suffix derived from the project id — so the same
 *  project always derives the same app name (idempotent redeploys never
 *  create a second app), while two different projects with the same NAME
 *  don't collide with each other. Not a security boundary, just entropy
 *  against Fly's global namespace — see nextAppNameAttempt for the rare real
 *  collision (an unrelated app already holds the exact same name). */
export function stableSuffix(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

/** The default app name for a project: `<slug(name)>-<hash(id)>`. Deterministic
 *  across redeploys; an explicit `fly.app` in the descriptor overrides it. */
export function deriveFlyAppName(projectName: string, projectId: string): string {
  return `${slugifyAppName(projectName)}-${stableSuffix(projectId)}`;
}

/** Fly rejects a `create`/`launch` when the name is already taken (by anyone,
 *  anywhere — the namespace is global). Deterministic bump so a retry is
 *  reproducible and stays well under the length cap. `attempt` starts at 1
 *  for the FIRST retry (the base name itself is attempt 0, tried by the
 *  caller before ever calling this). */
export function nextAppNameAttempt(baseAppName: string, attempt: number): string {
  return `${baseAppName}-${attempt + 1}`;
}

/** Read the `fly` sub-block + the shared `install`/`build`/`outputDir` fields
 *  out of an already-parsed `.skynet/preview.json` (or null if absent/
 *  malformed — see worktree.ts's readDescriptorRaw). Never throws; an
 *  unexpected shape just falls back to defaults. */
export function parseFlyDescriptor(raw: Record<string, unknown> | null): {
  fly: FlyDescriptor;
  build: string | null;
  outputDir: string | null;
} {
  const flyRaw = raw && typeof raw.fly === "object" && raw.fly !== null ? (raw.fly as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    fly: {
      app: str(flyRaw.app),
      region: str(flyRaw.region),
      size: str(flyRaw.size),
      memory: str(flyRaw.memory),
      org: str(flyRaw.org),
    },
    build: str(raw?.build) ?? null,
    outputDir: str(raw?.outputDir) ?? null,
  };
}

/** Merge the descriptor with defaults into a concrete config ready to deploy.
 *  Sizing defaults are Fly's smallest/cheapest so an operator is never
 *  surprised by cost; every default is descriptor-overridable. */
export function resolveFlyConfig(opts: { raw: Record<string, unknown> | null; projectName: string; projectId: string }): ResolvedFlyConfig {
  const { fly, build, outputDir } = parseFlyDescriptor(opts.raw);
  return {
    appName: fly.app || deriveFlyAppName(opts.projectName, opts.projectId),
    region: fly.region || FLY_DEFAULT_REGION,
    size: fly.size || FLY_DEFAULT_SIZE,
    memory: fly.memory || FLY_DEFAULT_MEMORY,
    org: fly.org || null,
    buildCmd: build,
    outputDir: outputDir || "dist",
  };
}

/** A minimal static-file image: nginx serving `outputDir`'s contents on
 *  port 80 (matched by generateFlyToml's internal_port). Used ONLY for the
 *  static-site path (`buildCmd` set) — a "service" deploy (a real backend)
 *  is NOT built locally; it's handed to `flyctl launch`, which detects the
 *  right builder (Dockerfile / buildpacks) for an arbitrary backend. */
export function generateStaticDockerfile(outputDir: string): string {
  return `FROM nginx:alpine\nCOPY ${outputDir} /usr/share/nginx/html\nEXPOSE 80\n`;
}

/** A minimal fly.toml for the static-site path. `auto_stop_machines` +
 *  `min_machines_running = 0` keep an idle deploy from burning compute (Fly
 *  spins the machine back up on the next request) — the persistent piece is
 *  the APP + its DNS name, not a permanently-running VM. */
export function generateFlyToml(cfg: { appName: string; region: string; size: string; memory: string }): string {
  return [
    `app = "${cfg.appName}"`,
    `primary_region = "${cfg.region}"`,
    "",
    "[build]",
    "",
    "[http_service]",
    "  internal_port = 80",
    "  force_https = true",
    "  auto_stop_machines = true",
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    "",
    "[[vm]]",
    `  size = "${cfg.size}"`,
    `  memory = "${cfg.memory}"`,
    "",
  ].join("\n");
}
