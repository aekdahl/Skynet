// [OSS-v1] Preview-API acceptance criteria (e): an integration test covering
// start → status → teardown for a per-run branch preview, against a REAL git
// repo and a REAL (tiny, dependency-free) spawned process — not mocked. The
// Operations wrapper's delegation is pinned (mocked manager) in
// preview-run-ops.test.ts; deep-review.test.ts/breaker-review.test.ts drive
// startRun for real but never call stop() in the same flow. This closes that
// gap and also pins acceptance criterion (d): a preview must not see the
// control-plane's own prod credentials (docs/live-preview.md's sandboxing note).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

const fetchBody = (url: string): Promise<string> =>
  new Promise((res, rej) => {
    httpGet(url, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => res(body));
    }).on("error", rej);
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-previewlife-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-previewlife-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
  mkdirSync(join(repo, ".skynet"));
  writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify({ dev: "node server.js" }));
  // Echoes back whatever it sees for a credential-shaped var, so the test can
  // assert directly on what actually reached the spawned process's env.
  writeFileSync(
    join(repo, "server.js"),
    "require('http').createServer((_q,r)=>r.end('key='+(process.env.ANTHROPIC_API_KEY||'none'))).listen(process.env.PORT);",
  );
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "agent/r1");
  writeFileSync(join(repo, "CHANGED.md"), "changed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "agent/r1");
  git("checkout", "-q", "main");

  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak-into-preview";
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("per-run preview lifecycle: start → status → teardown", () => {
  it("starts the run's branch, reports live status, serves it credential-free, then tears down", async () => {
    const mgr = new ProjectPreviewManager(worktreesDir);

    // start
    const started = await mgr.startRun("r1", { repoPath: repo, projectId: "p1", branch: "agent/r1" });
    expect(started.status).toBe("live");
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // status
    const status = mgr.state("run:r1");
    expect(status.status).toBe("live");
    expect(status.url).toBe(started.url);

    // the control plane's own credential never reached the previewed process
    const body = await fetchBody(started.url!);
    expect(body).toBe("key=none");

    // teardown
    const stopped = await mgr.stop("run:r1");
    expect(stopped.status).toBe("stopped");
    expect(mgr.state("run:r1")).toMatchObject({ status: "idle", url: null });
    await expect(fetchBody(started.url!)).rejects.toThrow();
  });
});
