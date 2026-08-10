// Fleet-scale visibility stress test — NOT part of the automated Acceptance
// suite on purpose: it spawns REAL, billed agent runs (needs a working provider
// credential on the server), so it must never fire unattended in CI or from the
// in-app QA panel. Run it by hand against a dev server when you want to eyeball
// whether Home's Runs board holds up under a busy fleet — 6 projects, 15
// tasks, 15 dedicated agents, all in flight at once — instead of the single
// project / single agent every other check exercises.
//
// Usage (from the skynet/ dir, against a running dev server with a real key):
//   node scripts/qa/fleet-scale-stress.mjs seed --repo /path/to/a/git/repo
//   … look around the app …
//   node scripts/qa/fleet-scale-stress.mjs cleanup --repo /path/to/a/git/repo
//
//   node scripts/qa/fleet-scale-stress.mjs run --repo /path/to/a/git/repo [--wait 60]
//     does seed → wait N seconds → cleanup in one shot (unattended smoke test).
//
// Every record it creates is name-prefixed "UAT: fleet-scale" (projects) /
// "uat-fleet-scale-" (agents) — `cleanup` sweeps by that prefix, so it finds and
// removes everything even after a crashed/interrupted `seed`, no state file
// needed. Deleting a project halts its live run(s) and frees the runner first
// (see operations.ts deleteProject), so agents are always idle by the time
// cleanup retires them.
//
// Deleting a project removes it from Skynet's store but does NOT touch the
// underlying git repo — the agent/* branches and the project's
// skynet/integration/<id> branch are real git history and Skynet leaves them
// alone on purpose. Pass --repo to cleanup too (same repo you seeded against)
// and it also sweeps those branches — otherwise you'll want to git-branch -D
// them by hand afterward.

import { execFileSync } from "node:child_process";

const URL = process.env.SKYNET_URL ?? "http://localhost:8080";
const TOKEN = process.env.SKYNET_TOKEN ?? "dev-cyberdyne";
const NAME_PREFIX = "UAT: fleet-scale";
const AGENT_PREFIX = "uat-fleet-scale-";
const PROJECT_COUNT = 6;
const TASK_COUNT = 15;
const MODEL = "haiku-4.5"; // cheapest/fastest Claude Code model — this is a UI load test, not a quality check

function args() {
  const a = process.argv.slice(3);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i + 1];
  }
  return out;
}

async function req(method, path, body) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  if (res.status === 204) return undefined;
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : undefined;
}

const snapshot = () => req("GET", "/api/snapshot");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Split TASK_COUNT tasks across PROJECT_COUNT projects, front-loaded (some
 *  projects busier than others is more representative than an even split). */
function distribution() {
  const base = Math.floor(TASK_COUNT / PROJECT_COUNT);
  const remainder = TASK_COUNT % PROJECT_COUNT;
  return Array.from({ length: PROJECT_COUNT }, (_, i) => base + (i < remainder ? 1 : 0));
}

async function seed({ repo }) {
  if (!repo) throw new Error("seed needs --repo <path to a local git repo>");
  console.log(`Seeding ${PROJECT_COUNT} projects / ${TASK_COUNT} tasks / ${TASK_COUNT} agents against ${URL} …`);

  const agents = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    const a = await req("POST", "/api/fleet/runners", { provider: "claude", model: MODEL, name: `${AGENT_PREFIX}${i}` });
    agents.push(a);
  }
  console.log(`  created ${agents.length} temp agents`);

  const counts = distribution();
  let taskIdx = 0;
  for (let p = 0; p < PROJECT_COUNT; p++) {
    const project = await req("POST", "/api/projects", {
      name: `${NAME_PREFIX} ${p + 1}`,
      goal: "Load-bearing fixture for the Home-lens visibility check — safe to delete anytime.",
      repoPath: repo,
    });
    for (let k = 0; k < counts[p]; k++) {
      const i = taskIdx++;
      const task = await req("POST", `/api/projects/${project.id}/tasks`, {
        text: `Create notes/agent-${i}.txt containing "ping from agent ${i}"`,
      });
      await req("POST", `/api/projects/${project.id}/tasks/${task.id}/assign`);
    }
    console.log(`  ${project.name}: ${counts[p]} tasks assigned`);
  }
  console.log("Seed complete — open the app and look at Home's Runs board.");
  console.log("Run `node scripts/qa/fleet-scale-stress.mjs cleanup` when done.");
}

function sweepGitBranches(repo, projectIds) {
  const branch = (...cmdArgs) => execFileSync("git", ["-C", repo, "branch", ...cmdArgs], { stdio: ["ignore", "pipe", "pipe"] });
  const list = (pattern) =>
    execFileSync("git", ["-C", repo, "branch", "--list", pattern], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.replace("*", "").trim())
      .filter(Boolean);

  // This script's own fixed task-naming pattern only — never a blanket agent/*
  // sweep, which could delete real unrelated work in a repo used for more than
  // this fixture.
  const agentBranches = list("agent/create-notes-agent-*");
  const integrationBranches = projectIds.map((id) => `skynet/integration/${id}`).filter((b) => list(b).includes(b));
  for (const b of [...agentBranches, ...integrationBranches]) {
    try {
      branch("-D", b);
      console.log(`  deleted git branch ${b}`);
    } catch (err) {
      console.warn(`  couldn't delete git branch ${b}: ${err.message}`);
    }
  }
}

async function cleanup({ repo } = {}) {
  const snap = await snapshot();
  const projects = snap.projects.filter((p) => p.name.startsWith(NAME_PREFIX));
  const projectIds = projects.map((p) => p.id);
  for (const p of projects) {
    await req("DELETE", `/api/projects/${p.id}`); // halts + frees any live run first
    console.log(`  deleted project ${p.name}`);
  }

  // Agents may take a beat to flip busy → idle after their project's runs were
  // halted above — retry the retire a few times instead of racing it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const fleet = (await snapshot()).fleet.filter((r) => r.name.startsWith(AGENT_PREFIX));
    if (fleet.length === 0) break;
    let anyBusy = false;
    for (const r of fleet) {
      try {
        await req("DELETE", `/api/fleet/runners/${r.id}`);
        console.log(`  retired agent ${r.name}`);
      } catch {
        anyBusy = true; // still busy — try again next pass
      }
    }
    if (!anyBusy) break;
    await sleep(1000);
  }
  const left = (await snapshot()).fleet.filter((r) => r.name.startsWith(AGENT_PREFIX));
  if (left.length > 0) console.warn(`  ${left.length} temp agent(s) still busy — re-run cleanup shortly.`);

  if (repo) sweepGitBranches(repo, projectIds);
  else console.log("  (no --repo given — the agent/* and skynet/integration/* branches this run created are still in the repo)");

  if (left.length === 0) console.log("Cleanup complete — no UAT fleet-scale records remain.");
}

async function main() {
  const cmd = process.argv[2];
  const a = args();
  if (cmd === "seed") return seed(a);
  if (cmd === "cleanup") return cleanup(a);
  if (cmd === "run") {
    await seed(a);
    const waitSecs = Number(a.wait ?? 60);
    console.log(`Waiting ${waitSecs}s for the fleet to churn before cleanup…`);
    await sleep(waitSecs * 1000);
    return cleanup(a);
  }
  console.error("Usage: node scripts/qa/fleet-scale-stress.mjs <seed --repo <path>|cleanup|run --repo <path> [--wait 60]>");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
