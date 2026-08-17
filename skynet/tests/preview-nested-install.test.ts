// A recipe for a nested monorepo can embed its OWN install step for a
// sub-package the root-level ensureDeps()/symlink never reaches (e.g. `cd
// apps/web && pnpm install && pnpm dev`). Unlike the root install, nothing
// used to skip that embedded step once it was already warm — it reran on
// every single start/restart (ROADMAP.md's "warm-worktree dep caching" gap).
// This drives the real ProjectPreviewManager against a throwaway git repo, a
// FAKE `npm` on PATH (so "npm install" is genuinely exercised — matched by
// the real detection regex — without a slow/flaky real network install), and
// asserts on the actual log lines + on-disk marker, not just timing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: ENV }).toString();

describe("preview — skip a nested sub-package's embedded install when it's already warm", () => {
  let repo: string;
  let wtRoot: string;
  let binDir: string;
  let originalPath: string | undefined;
  let mgr: ProjectPreviewManager;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pni-repo-"));
    wtRoot = mkdtempSync(join(tmpdir(), "pni-wt-"));
    binDir = mkdtempSync(join(tmpdir(), "pni-bin-"));

    // A fake `npm` standing in for the real package manager: fast, offline,
    // deterministic, and — because it's literally named "npm" and invoked as
    // "npm install" — genuinely exercised by EMBEDDED_INSTALL_RE, not a
    // stand-in string the regex would never actually see.
    const fakeNpm = join(binDir, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nif [ "$1" = "install" ]; then\n  mkdir -p node_modules\n  echo FAKE_NPM_INSTALL_RAN\nfi\nexit 0\n`,
    );
    chmodSync(fakeNpm, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "package.json"), '{"name":"sub","version":"1.0.0"}\n');
    writeFileSync(join(repo, "sub", "package-lock.json"), '{"lockfileVersion":1,"v":"v1"}\n');
    mkdirSync(join(repo, ".skynet"), { recursive: true });
    // No trailing dev-server process — just prints and exits, so the preview
    // ends up "failed" (no port ever answers) but the install/skip side
    // effects already happened by then; same pattern preview-latest-combine
    // .test.ts uses for a recipe-less repo.
    writeFileSync(
      join(repo, ".skynet", "preview.json"),
      JSON.stringify({ dev: "cd sub && npm install && echo APP_READY", port: 5999 }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");

    mgr = new ProjectPreviewManager(wtRoot);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const d of [repo, wtRoot, binDir]) rmSync(d, { recursive: true, force: true });
  });

  const commitLockfile = (content: string) => {
    writeFileSync(join(repo, "sub", "package-lock.json"), content);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "bump lockfile");
  };

  it("cold start: no marker yet → the embedded install runs", async () => {
    const st = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    expect(st.logs.join("\n")).toMatch(/FAKE_NPM_INSTALL_RAN/);
    expect(st.logs.join("\n")).not.toMatch(/skipping embedded install/);
    const markerDir = join(wtRoot, "preview-p1", ".skynet", "preview-installs");
    expect(existsSync(markerDir)).toBe(true);
  });

  it("warm restart, unchanged lockfile: the embedded install is skipped", async () => {
    await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    const st2 = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" }); // restart == start again
    const logs2 = st2.logs.join("\n");
    expect(logs2).toMatch(/skipping embedded install in sub/);
    expect(logs2).not.toMatch(/FAKE_NPM_INSTALL_RAN/);
    // The command actually spawned no longer contains the install segment.
    expect(logs2).toMatch(/▸ cd sub && echo APP_READY/);
  });

  it("warm restart, changed lockfile: the embedded install runs again", async () => {
    await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    commitLockfile('{"lockfileVersion":1,"v":"v2"}\n');
    const st3 = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    const logs3 = st3.logs.join("\n");
    expect(logs3).toMatch(/FAKE_NPM_INSTALL_RAN/);
    expect(logs3).not.toMatch(/skipping embedded install/);
  });

  it("refresh: re-runs the nested install only when the diff touched that sub-package's lockfile", async () => {
    // Warm it up first (writes the marker for v1).
    await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    const dir = join(wtRoot, "preview-p1");
    const recipe = { cmd: "cd sub && npm install && echo APP_READY", port: 5999, source: "descriptor" as const };
    const live = {
      status: "live", key: "p1", dir, gitRepo: repo, recipeKey: "p1", refreshBranch: "main",
      recipe, port: 5999, logs: [] as string[], error: null, startedAt: 0, lastTouched: 0, source: "main" as const,
    };
    (mgr as unknown as { previews: Map<string, unknown> }).previews.set("p1", live);

    // An UNRELATED merge (touches a different file entirely) — should NOT
    // trigger a nested reinstall.
    writeFileSync(join(repo, "README.md"), "unrelated change\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "unrelated");
    await mgr.refresh("p1");
    expect((live.logs as string[]).join("\n")).not.toMatch(/re-installing there/);

    // NOW bump the sub-package's lockfile — should trigger a nested reinstall.
    commitLockfile('{"lockfileVersion":1,"v":"v2"}\n');
    await mgr.refresh("p1");
    const logs = (live.logs as string[]).join("\n");
    expect(logs).toMatch(/merged changes touched sub's dependencies — re-installing there/);
    expect(logs).toMatch(/FAKE_NPM_INSTALL_RAN/);
  });
});
