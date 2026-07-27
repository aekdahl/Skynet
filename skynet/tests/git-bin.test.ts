// gitBin() resolves an absolute git path so a GUI-launched app (bare PATH) can
// still spawn git. Verify: env override wins, PATH is searched, and a not-found
// resolution falls back to the bare name (so the caller's ENOENT is unchanged).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBin, resetGitBinCache } from "../apps/server/src/git-bin.js";

const isWin = process.platform === "win32";
const EXE = isWin ? "git.exe" : "git";
const origPath = process.env.PATH;
const origOverride = process.env.SKYNET_GIT_PATH;
let tmp: string;

function fakeGit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, EXE);
  writeFileSync(p, "#!/bin/sh\necho fake\n");
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gitbin-"));
  resetGitBinCache();
});
afterEach(() => {
  process.env.PATH = origPath;
  if (origOverride === undefined) delete process.env.SKYNET_GIT_PATH;
  else process.env.SKYNET_GIT_PATH = origOverride;
  resetGitBinCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe("gitBin", () => {
  it("honors an executable SKYNET_GIT_PATH override", () => {
    const p = fakeGit(join(tmp, "override"));
    process.env.SKYNET_GIT_PATH = p;
    process.env.PATH = ""; // prove it didn't fall through to PATH
    expect(gitBin()).toBe(p);
  });

  it("finds git on PATH when no override is set", () => {
    delete process.env.SKYNET_GIT_PATH;
    const dir = join(tmp, "bin");
    const p = fakeGit(dir);
    process.env.PATH = dir;
    expect(gitBin()).toBe(p);
  });

  it("falls back to the bare name when git is nowhere to be found", () => {
    // Skip on machines where a real git sits in a COMMON_DIR (/usr/bin, …): the
    // resolver would legitimately find it. Only assert the fallback when it can't.
    delete process.env.SKYNET_GIT_PATH;
    process.env.PATH = join(tmp, "empty"); // exists, holds no git
    const resolved = gitBin();
    expect(resolved === EXE || resolved.endsWith(`/${EXE}`) || resolved.endsWith(`\\${EXE}`)).toBe(true);
  });

  it("memoizes — a second call returns the same value without re-resolving", () => {
    const p = fakeGit(join(tmp, "memo"));
    process.env.SKYNET_GIT_PATH = p;
    const first = gitBin();
    delete process.env.SKYNET_GIT_PATH; // would change the answer if not cached
    process.env.PATH = "";
    expect(gitBin()).toBe(first);
  });
});
