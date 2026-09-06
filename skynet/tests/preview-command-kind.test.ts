// Phase 3 (docs/live-preview.md) — a "command"-kind preview runs a command to
// COMPLETION and surfaces its exit code + declared artifacts instead of
// iframing a server. Drives the REAL ProjectPreviewManager against a
// throwaway git repo, same pattern as preview-latest-combine.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

function writeDescriptor(desc: Record<string, unknown>) {
  mkdirSync(join(repo, ".skynet"), { recursive: true });
  writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify(desc));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-cmd-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-cmd-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const commit = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
};

describe("command-kind preview", () => {
  it("runs the declared command, reports exit code 0 and the produced artifact", async () => {
    writeFileSync(join(repo, "run.js"), "require('fs').writeFileSync('out.txt', 'hello'); console.log('done');");
    writeDescriptor({ kind: "command", command: "node run.js", artifacts: ["out.txt"] });
    commit("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo);

    expect(st.kind).toBe("command");
    expect(st.status).toBe("live");
    expect(st.exitCode).toBe(0);
    expect(st.logs.some((l) => l.includes("done"))).toBe(true);
    expect(st.artifacts).toHaveLength(1);
    expect(st.artifacts[0]).toMatchObject({ path: "out.txt", size: 5 });
    expect(st.artifacts[0]!.url).toMatch(/^\/preview-artifact\/[^/]+\/out\.txt$/);
  });

  it("reports a non-zero exit as failed, with the exit code preserved", async () => {
    writeFileSync(join(repo, "run.js"), "console.error('boom'); process.exit(1);");
    writeDescriptor({ kind: "command", command: "node run.js" });
    commit("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo);

    expect(st.status).toBe("failed");
    expect(st.exitCode).toBe(1);
    expect(st.error).toMatch(/exited \(code 1\)/);
  });

  it("fails clearly when kind:\"command\" has no command/start/dev to run", async () => {
    writeDescriptor({ kind: "command" });
    commit("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo);

    expect(st.status).toBe("failed");
    expect(st.error).toMatch(/no "command"/);
  });

  it("re-runs the command on refresh, picking up the new artifact content", async () => {
    writeFileSync(join(repo, "run.js"), "require('fs').writeFileSync('out.txt', require('fs').readFileSync('src.txt'));");
    writeFileSync(join(repo, "src.txt"), "v1");
    writeDescriptor({ kind: "command", command: "node run.js", artifacts: ["out.txt"] });
    commit("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const first = await mgr.start("p1", repo, undefined, { baseBranch: "main" });
    expect(first.status).toBe("live");
    expect(readFileSync(join(worktreesDir, "preview-p1", "out.txt"), "utf8")).toBe("v1");

    writeFileSync(join(repo, "src.txt"), "v2");
    commit("v2");

    const after = await mgr.refresh("p1");
    expect(after.status).toBe("live");
    expect(readFileSync(join(worktreesDir, "preview-p1", "out.txt"), "utf8")).toBe("v2");
  });
});
