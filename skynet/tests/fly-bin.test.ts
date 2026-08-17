// flyctlBin() resolves an absolute flyctl path the same way gitBin() does (see
// git-bin.test.ts) — a GUI-launched app doesn't inherit a login-shell PATH, and
// flyctl's own installer drops the binary in ~/.fly/bin, which a bare GUI PATH
// never includes either way. Verify: env override wins, PATH is searched, and a
// not-found resolution falls back to the bare name (the caller's ENOENT is
// unchanged, which fly/deploy.ts turns into an "install flyctl" hint).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flyctlBin, resetFlyctlBinCache } from "../apps/server/src/fly/fly-bin.js";

const isWin = process.platform === "win32";
const EXE = isWin ? "flyctl.exe" : "flyctl";
const origPath = process.env.PATH;
const origOverride = process.env.SKYNET_FLYCTL_PATH;
let tmp: string;

function fakeFlyctl(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, EXE);
  writeFileSync(p, "#!/bin/sh\necho fake\n");
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "flybin-"));
  resetFlyctlBinCache();
});
afterEach(() => {
  process.env.PATH = origPath;
  if (origOverride === undefined) delete process.env.SKYNET_FLYCTL_PATH;
  else process.env.SKYNET_FLYCTL_PATH = origOverride;
  resetFlyctlBinCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe("flyctlBin", () => {
  it("honors an executable SKYNET_FLYCTL_PATH override", () => {
    const p = fakeFlyctl(join(tmp, "override"));
    process.env.SKYNET_FLYCTL_PATH = p;
    process.env.PATH = ""; // prove it didn't fall through to PATH
    expect(flyctlBin()).toBe(p);
  });

  it("finds flyctl on PATH when no override is set", () => {
    delete process.env.SKYNET_FLYCTL_PATH;
    const dir = join(tmp, "bin");
    const p = fakeFlyctl(dir);
    process.env.PATH = dir;
    expect(flyctlBin()).toBe(p);
  });

  it("falls back to the bare name when flyctl is nowhere to be found", () => {
    delete process.env.SKYNET_FLYCTL_PATH;
    process.env.PATH = join(tmp, "empty"); // exists, holds no flyctl
    const resolved = flyctlBin();
    expect(resolved === EXE || resolved.endsWith(`/${EXE}`) || resolved.endsWith(`\\${EXE}`)).toBe(true);
  });

  it("memoizes — a second call returns the same value without re-resolving", () => {
    const p = fakeFlyctl(join(tmp, "memo"));
    process.env.SKYNET_FLYCTL_PATH = p;
    const first = flyctlBin();
    delete process.env.SKYNET_FLYCTL_PATH; // would change the answer if not cached
    process.env.PATH = "";
    expect(flyctlBin()).toBe(first);
  });
});
