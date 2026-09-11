// A "command"-kind preview declares its output files as glob patterns
// (`.skynet/preview.json`'s `artifacts`) — no glob library exists in this
// repo (grep confirms), so matchGlob/collectArtifacts are hand-rolled, same
// as parsePreviewPorts/injectViteBase. Pure/fs-only — no process spawning.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchGlob, collectArtifacts } from "../apps/server/src/preview/project-preview.js";

describe("matchGlob", () => {
  it("matches a literal path with no wildcard", () => {
    expect(matchGlob("coverage/report.html", "coverage/report.html")).toBe(true);
    expect(matchGlob("coverage/report.html", "coverage/other.html")).toBe(false);
  });
  it("* matches within a single path segment only", () => {
    expect(matchGlob("dist/*.png", "dist/a.png")).toBe(true);
    expect(matchGlob("dist/*.png", "dist/sub/a.png")).toBe(false);
    expect(matchGlob("dist/*.png", "dist/a.png/x")).toBe(false);
  });
  it("** crosses any number of path segments, including zero", () => {
    expect(matchGlob("out/**/*.png", "out/a.png")).toBe(true); // zero intervening dirs
    expect(matchGlob("out/**/*.png", "out/a/b/c.png")).toBe(true);
    expect(matchGlob("out/**/*.png", "other/a.png")).toBe(false);
  });
  it("doesn't match an unrelated path", () => {
    expect(matchGlob("dist/*.png", "dist/a.jpg")).toBe(false);
    expect(matchGlob("dist/*.png", "notdist/a.png")).toBe(false);
  });
});

describe("collectArtifacts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skynet-artifacts-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when no patterns are declared", () => {
    writeFileSync(join(dir, "out.txt"), "hi");
    expect(collectArtifacts(dir, [], "tok")).toEqual([]);
  });

  it("collects a matching file with size/mime/url", () => {
    writeFileSync(join(dir, "out.txt"), "hello world");
    const found = collectArtifacts(dir, ["out.txt"], "tok123");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "out.txt", size: 11, mime: "text/plain; charset=utf-8" });
    expect(found[0]!.url).toBe("/preview-artifact/tok123/out.txt");
  });

  it("skips .git and node_modules while walking nested dirs", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.png"), "img");
    writeFileSync(join(dir, "node_modules", "pkg", "b.png"), "img");
    writeFileSync(join(dir, ".git", "c.png"), "img");
    const found = collectArtifacts(dir, ["**/*.png"], "tok");
    expect(found.map((f) => f.path)).toEqual(["sub/a.png"]);
  });

  it("doesn't collect a file that matches no pattern", () => {
    writeFileSync(join(dir, "unrelated.log"), "noise");
    expect(collectArtifacts(dir, ["*.png"], "tok")).toEqual([]);
  });
});
