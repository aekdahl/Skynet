// ─── Repo scan for the quality panel ────────────────────────────────────────
// Walks a checked-out branch and splits it into source vs test files, then runs
// the pure analyzer over them (see scenarios.ts). Also picks up a standard
// `coverage-summary.json` when the project already produces one.
//
// Reads only — never runs the project's toolchain. That is deliberate: this
// backs a UI panel an operator opens on demand, so it has to finish in
// milliseconds and must never execute code from a repo an agent just wrote.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { scenarioReport, type ScenarioReport, type SourceFile } from "./scenarios.js";

/** Directories never worth walking — vendored code, build output, VCS. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo", "coverage",
  ".cache", "vendor", "target", "__pycache__", ".venv", "venv",
]);
const CODE_EXT = /\.(ts|tsx|mts|cts)$/;
/** Conventional test markers across the common JS/TS layouts. */
const TEST_RE = /(\.test\.|\.spec\.|(^|[\\/])(tests?|__tests__|e2e)[\\/])/;

// Bounds so a monorepo can't stall the request or blow memory. A repo past
// these is still analysed — just on a representative slice, which the report
// reports honestly via sourceFiles/testFiles.
const MAX_FILES = 4000;
const MAX_BYTES = 400_000;

async function walk(root: string, dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    if (e.name.startsWith(".") && e.name !== ".") {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, join(dir, e.name), acc);
    } else if (CODE_EXT.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
}

async function load(root: string, abs: string): Promise<SourceFile | null> {
  const s = await stat(abs).catch(() => null);
  if (!s || s.size > MAX_BYTES) return null;
  const content = await readFile(abs, "utf8").catch(() => null);
  if (content == null) return null;
  return { path: relative(root, abs).split(sep).join("/"), content };
}

/** Line/branch coverage, when the repo already emits a standard summary. */
export interface CoverageSummary {
  lines: number;
  statements: number;
  branches: number;
  functions: number;
  /** Where it was read from, so the panel can say whether it's stale. */
  path: string;
  generatedAt: number | null;
}

const COVERAGE_PATHS = [
  "coverage/coverage-summary.json",
  "coverage/coverage-final.json",
  ".coverage/coverage-summary.json",
];

/** Read an istanbul-style `coverage-summary.json` if one exists. Returns null
 *  when the project has no coverage configured — a fact the panel states
 *  plainly rather than rendering a misleading zero. */
export async function readCoverage(root: string): Promise<CoverageSummary | null> {
  for (const rel of COVERAGE_PATHS) {
    const abs = join(root, rel);
    const raw = await readFile(abs, "utf8").catch(() => null);
    if (raw == null) continue;
    try {
      const parsed = JSON.parse(raw) as { total?: Record<string, { pct?: number }> };
      const t = parsed.total;
      if (!t) continue;
      const pct = (k: string) => (typeof t[k]?.pct === "number" ? t[k]!.pct! : 0);
      const s = await stat(abs).catch(() => null);
      return {
        lines: pct("lines"),
        statements: pct("statements"),
        branches: pct("branches"),
        functions: pct("functions"),
        path: rel,
        generatedAt: s ? Math.round(s.mtimeMs) : null,
      };
    } catch {
      /* malformed — treat as absent rather than failing the whole panel */
    }
  }
  return null;
}

export interface QualityScan {
  scenarios: ScenarioReport;
  coverage: CoverageSummary | null;
  scannedAt: number;
}

/** Scan a checked-out repo root. Works on any branch — nothing here depends on
 *  Skynet's own task/run records, only on the code that is present. */
export async function scanRepo(root: string, now: number): Promise<QualityScan> {
  const files: string[] = [];
  await walk(root, root, files);
  const loaded = (await Promise.all(files.map((f) => load(root, f)))).filter((f): f is SourceFile => f !== null);
  const tests = loaded.filter((f) => TEST_RE.test(f.path));
  const sources = loaded.filter((f) => !TEST_RE.test(f.path));
  return {
    scenarios: scenarioReport(sources, tests),
    coverage: await readCoverage(root),
    scannedAt: now,
  };
}
