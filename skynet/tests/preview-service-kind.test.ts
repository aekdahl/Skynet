// Live preview Phase 2 (docs/live-preview.md "Phase-2 v0"): `kind: "service"`
// descriptor support — a build step, a custom health-check path, and (the
// core new capability) a debounced rebuild-restart on merge, since a plain
// server process has no HMR of its own to rely on the way Phase 1's web
// previews do. Same style as tests/preview-run-lifecycle.test.ts: a REAL git
// repo, REAL tiny dependency-free Node http-server fixtures, no mocking of
// the manager.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager, type PreviewState } from "../apps/server/src/preview/project-preview.js";

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const commitAll = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
};

const fetchBody = (url: string): Promise<string> =>
  new Promise((res, rej) => {
    httpGet(url, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => res(body));
    }).on("error", rej);
  });

/** Poll mgr.state(key) until it matches `want`, or throw after `timeoutMs`. */
async function waitForStatus(mgr: ProjectPreviewManager, key: string, want: PreviewState["status"], timeoutMs = 15_000): Promise<PreviewState> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = mgr.state(key);
    if (st.status === want) return st;
    if (Date.now() > until) throw new Error(`state(${key}) never reached "${want}" (last: ${st.status} ${st.error ?? ""})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Poll a predicate until it's true, or throw after `timeoutMs`. Used to wait
 *  for the DEBOUNCED rebuild to actually fire (see armRebuild/REBUILD_DEBOUNCE_MS)
 *  before asserting on its effects — a status check alone races the debounce
 *  window, since the preview is already "live" (from before the merge) the
 *  instant refresh() resolves. */
async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-previewsvc-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-previewsvc-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

// Build step: copies VERSION.txt (tracked, changes across "merges") into
// dist/version.txt, and bumps a build-count marker so tests can assert HOW
// MANY TIMES the build actually ran (once at start, once per rebuild — never
// once per merge when several land within the debounce window).
const BUILD_JS = `
const fs = require("fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/version.txt", fs.readFileSync("VERSION.txt", "utf8"));
const prev = fs.existsSync("build-count.txt") ? parseInt(fs.readFileSync("build-count.txt", "utf8") || "0", 10) : 0;
fs.writeFileSync("build-count.txt", String(prev + 1));
`;
// Serves whatever dist/version.txt currently holds — read fresh on every
// request (not cached at boot), so a rebuild+restart is the only way its
// response changes (a plain "git checkout" with no restart would keep
// serving the OLD process, which is exactly what this is proving doesn't happen).
const SERVER_JS = `
require("http").createServer((_q, r) => r.end(require("fs").readFileSync("dist/version.txt", "utf8"))).listen(process.env.PORT);
`;

function writeServiceFixture(version: string) {
  mkdirSync(join(repo, ".skynet"));
  writeFileSync(
    join(repo, ".skynet", "preview.json"),
    JSON.stringify({ kind: "service", build: "node build.js", start: "node server.js" }),
  );
  writeFileSync(join(repo, "build.js"), BUILD_JS);
  writeFileSync(join(repo, "server.js"), SERVER_JS);
  writeFileSync(join(repo, "VERSION.txt"), version);
}

describe("service-kind preview: build step, then serve via start", () => {
  it("runs the descriptor's build before serving, and reports kind: service", async () => {
    writeServiceFixture("v1");
    commitAll("base");
    const mgr = new ProjectPreviewManager(worktreesDir);

    const started = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    expect(started.status).toBe("live");
    expect(started.kind).toBe("service");
    expect(await fetchBody(started.url!)).toBe("v1");

    await mgr.stop("p1");
  });
});

describe("service-kind preview: kind:'web' (default) never runs a declared build", () => {
  it("ignores a `build` field when the descriptor has no kind (backward-compat with Fly's own use of `build`)", async () => {
    mkdirSync(join(repo, ".skynet"));
    // No "kind" — same shape a Fly-deploy-only descriptor already has today.
    writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify({ build: "node build.js", start: "node server.js" }));
    writeFileSync(join(repo, "build.js"), BUILD_JS);
    writeFileSync(join(repo, "VERSION.txt"), "v1");
    writeFileSync(join(repo, "server.js"), "require('http').createServer((_q,r)=>r.end('hello')).listen(process.env.PORT);");
    commitAll("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const started = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    expect(started.status).toBe("live");
    expect(started.kind).toBe("web");
    expect(existsSync(mgr.dirFor("p1")! + "/build-count.txt")).toBe(false); // build never ran

    // A "merge" lands (a new commit on the tracked branch) — refresh() should
    // just re-point the worktree (existing Phase-1 behavior), never arm a
    // rebuild-restart for a "web" preview.
    writeFileSync(join(repo, "VERSION.txt"), "v2");
    commitAll("merge");
    await mgr.refresh("p1");
    await new Promise((r) => setTimeout(r, 2000)); // well past REBUILD_DEBOUNCE_MS
    const st = mgr.state("p1");
    expect(st.status).toBe("live"); // never dipped into "starting" for a rebuild
    expect(st.logs.some((l) => /rebuilding|restarting — merged/.test(l))).toBe(false);

    await mgr.stop("p1");
  });
});

describe("service-kind preview: healthPath overrides the health-check probe path", () => {
  it("probes the configured path instead of the default '/'", async () => {
    mkdirSync(join(repo, ".skynet"));
    writeFileSync(
      join(repo, ".skynet", "preview.json"),
      JSON.stringify({ kind: "service", start: "node server.js", healthPath: "/healthz" }),
    );
    writeFileSync(
      join(repo, "server.js"),
      `const fs = require("fs");
       require("http").createServer((req, res) => {
         fs.appendFileSync("requests.log", req.url + "\\n");
         res.writeHead(200);
         res.end("ok");
       }).listen(process.env.PORT);`,
    );
    commitAll("base");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const started = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    expect(started.status).toBe("live");

    const log = readFileSync(join(mgr.dirFor("p1")!, "requests.log"), "utf8");
    const lines = log.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l === "/healthz")).toBe(true); // never probed the default "/"

    await mgr.stop("p1");
  });
});

describe("service-kind preview: auto-rebuild-restart on merge", () => {
  it("rebuilds and restarts (not just relies on HMR) when refresh() sees a new commit", async () => {
    writeServiceFixture("v1");
    commitAll("base");
    const mgr = new ProjectPreviewManager(worktreesDir);

    const started = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    expect(started.status).toBe("live");
    expect(await fetchBody(started.url!)).toBe("v1");

    // Simulate a merge landing on the tracked (base) branch.
    writeFileSync(join(repo, "VERSION.txt"), "v2");
    commitAll("merge v2");
    await mgr.refresh("p1");

    // refresh() only ARMS a debounced rebuild — the preview is still "live"
    // (from before the merge) the instant refresh() resolves, so wait for the
    // debounce to actually fire before checking status/served content.
    await waitFor(() => mgr.state("p1").logs.some((l) => l.includes("rebuilding")));
    const live = await waitForStatus(mgr, "p1", "live");
    expect(await fetchBody(live.url!)).toBe("v2"); // the NEW process serving the rebuilt output

    await mgr.stop("p1");
  }, 30_000);

  it("debounces a burst of merges into a single rebuild", async () => {
    writeServiceFixture("v1");
    commitAll("base");
    const mgr = new ProjectPreviewManager(worktreesDir);

    await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main" });
    const dir = mgr.dirFor("p1")!;
    const countAfterStart = Number(readFileSync(join(dir, "build-count.txt"), "utf8"));
    expect(countAfterStart).toBe(1); // the initial build

    // Two "merges" landing in quick succession — well within REBUILD_DEBOUNCE_MS.
    writeFileSync(join(repo, "VERSION.txt"), "v2");
    commitAll("merge v2");
    await mgr.refresh("p1");
    writeFileSync(join(repo, "VERSION.txt"), "v3");
    commitAll("merge v3");
    await mgr.refresh("p1");

    await waitFor(() => mgr.state("p1").logs.filter((l) => l.includes("rebuilding")).length > 0);
    await waitForStatus(mgr, "p1", "live");
    const countAfterBurst = Number(readFileSync(join(dir, "build-count.txt"), "utf8"));
    expect(countAfterBurst).toBe(countAfterStart + 1); // ONE rebuild, not two

    await mgr.stop("p1");
  }, 30_000);
});
