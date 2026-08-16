// ─── Fly.io deploy module ──────────────────────────────────────────────────
// A REAL, persistent deployment option alongside the ephemeral local live
// preview (../preview/). See docs/live-preview.md §"Deploy to Fly.io".

export { FlyDeployManager, flyDeploy, type FlyDeployState, type FlyDeployStartOpts } from "./deploy.js";
export { flyctlBin } from "./fly-bin.js";
export {
  deriveFlyAppName,
  generateFlyToml,
  generateStaticDockerfile,
  nextAppNameAttempt,
  parseFlyDescriptor,
  resolveFlyConfig,
  slugifyAppName,
  stableSuffix,
  FLY_DEFAULT_MEMORY,
  FLY_DEFAULT_REGION,
  FLY_DEFAULT_SIZE,
  type FlyDescriptor,
  type ResolvedFlyConfig,
} from "./descriptor.js";
