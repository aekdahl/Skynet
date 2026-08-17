// End-to-end coverage of FlyDeployManager's orchestration — worktree prep,
// local static build, Dockerfile/fly.toml generation, app-name collision
// retry, and teardown — against a REAL git repo and a FAKE flyctl (a tiny
// shell script standing in for the real binary). No network, no real Fly
// account: this is exactly what task-8 calls "the parts that don't require a
// real Fly account." A genuine end-to-end deploy still needs one — see
// docs/live-preview.md §"Deploy to Fly.io" → "Manual verification".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlyDeployManager } from "../apps/server/src/fly/deploy.js";
import { resetFlyctlBinCache } from "../apps/server/src/fly/fly-bin.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: ENV }).toString().trim();

/** A fake `flyctl` whose behavior is driven entirely by argv, so each test can
 *  script a specific scenario (a taken app name, a failing deploy, …) without
 *  ever touching the network. */
function fakeFlyctl(dir: string, opts: { takenAppName?: string; failDeploy?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "flyctl");
  const taken = opts.takenAppName ?? "__none__";
  writeFileSync(
    p,
    `#!/bin/sh
echo "flyctl $@" >&2
case "$1" in
  launch) exit 0 ;;
  apps)
    if [ "$2" = "create" ]; then
      if [ "$3" = "${taken}" ]; then echo "Error: Name has already been taken" >&2; exit 1; fi
      exit 0
    elif [ "$2" = "destroy" ]; then
      exit 0
    fi
    ;;
  status) exit 1 ;; # "not found" — nobody (including us) has claimed the retried name
  deploy) ${opts.failDeploy ? 'echo "build failed: fake error" >&2; exit 1' : "exit 0"} ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(p, 0o755);
  return p;
}

describe("FlyDeployManager — static-site deploy path", () => {
  let repo: string;
  let wtRoot: string;
  let flyctlDir: string;
  let mgr: FlyDeployManager;
  const origOverride = process.env.SKYNET_FLYCTL_PATH;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "flydeploy-repo-"));
    wtRoot = mkdtempSync(join(tmpdir(), "flydeploy-wt-"));
    flyctlDir = mkdtempSync(join(tmpdir(), "flydeploy-bin-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, ".skynet"), { recursive: true });
    writeFileSync(
      join(repo, ".skynet", "preview.json"),
      JSON.stringify({ build: "mkdir -p dist && echo '<html>hi</html>' > dist/index.html", outputDir: "dist", fly: { region: "lhr" } }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    mgr = new FlyDeployManager(wtRoot);
  });
  afterEach(() => {
    for (const d of [repo, wtRoot, flyctlDir]) rmSync(d, { recursive: true, force: true });
    if (origOverride === undefined) delete process.env.SKYNET_FLYCTL_PATH;
    else process.env.SKYNET_FLYCTL_PATH = origOverride;
    resetFlyctlBinCache();
  });

  it("builds locally, generates fly.toml/Dockerfile, and reports a live https://<app>.fly.dev URL", async () => {
    process.env.SKYNET_FLYCTL_PATH = fakeFlyctl(flyctlDir);
    resetFlyctlBinCache();

    const result = await mgr.start({
      key: "proj-1", gitRepo: repo, ref: "main", branch: "main",
      projectId: "proj-1", projectName: "Demo Site", flyApiToken: "fo1_test",
    });

    expect(result.status).toBe("live");
    expect(result.appName).toMatch(/^demo-site-[0-9a-f]{8}$/);
    expect(result.url).toBe(`https://${result.appName}.fly.dev`);
    expect(result.region).toBe("lhr"); // from the descriptor's fly.region override
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe("main");
    expect(result.deployedAt).not.toBeNull();

    // The static build actually ran, and the generated deploy assets are present
    // in the (namespaced-separately-from-preview) worktree.
    const dir = join(wtRoot, "fly-proj-1");
    expect(existsSync(join(dir, "dist", "index.html"))).toBe(true);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain("COPY dist /usr/share/nginx/html");
    expect(readFileSync(join(dir, "fly.toml"), "utf8")).toContain('primary_region = "lhr"');
  });

  it("retries with a deterministic suffix when the derived app name is taken, and reports the name it actually used", async () => {
    // Pin an explicit app name via the descriptor, then simulate Fly rejecting
    // exactly that name (someone else already owns it) — the retry should land
    // on "<name>-1" and succeed.
    writeFileSync(
      join(repo, ".skynet", "preview.json"),
      JSON.stringify({ build: "mkdir -p dist && echo hi > dist/index.html", outputDir: "dist", fly: { app: "wanted-name", region: "iad" } }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pin app name");

    process.env.SKYNET_FLYCTL_PATH = fakeFlyctl(flyctlDir, { takenAppName: "wanted-name" });
    resetFlyctlBinCache();

    const result = await mgr.start({
      key: "proj-2", gitRepo: repo, ref: "main", branch: "main",
      projectId: "proj-2", projectName: "Demo", flyApiToken: "fo1_test",
    });

    expect(result.status).toBe("live");
    expect(result.appName).toBe("wanted-name-1");
    expect(result.url).toBe("https://wanted-name-1.fly.dev");
  });

  it("a failing flyctl deploy surfaces as status=failed with the output tail in the error", async () => {
    process.env.SKYNET_FLYCTL_PATH = fakeFlyctl(flyctlDir, { failDeploy: true });
    resetFlyctlBinCache();

    const result = await mgr.start({
      key: "proj-3", gitRepo: repo, ref: "main", branch: "main",
      projectId: "proj-3", projectName: "Demo", flyApiToken: "fo1_test",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code|build failed/i);
  });

  it("destroy() tears the app down and clears the URL — even called fresh (no prior in-memory state)", async () => {
    process.env.SKYNET_FLYCTL_PATH = fakeFlyctl(flyctlDir);
    resetFlyctlBinCache();

    // Simulate a post-restart operator action: a brand-new manager instance
    // (nothing in memory), destroying by the appName persisted on the Project
    // record — exactly the path operations.ts's flyDeployProjectStop takes.
    const fresh = new FlyDeployManager(wtRoot);
    const result = await fresh.destroy({ key: "proj-1", appName: "demo-site-deadbeef", flyApiToken: "fo1_test", gitRepo: repo });

    expect(result.status).toBe("stopped");
    expect(result.url).toBeNull();
    expect(result.appName).toBeNull();
  });
});
