// ─── Scenario coverage ──────────────────────────────────────────────────────
// "How well does the thing we built actually work?" — the question line
// coverage cannot answer. Line coverage tells you which STATEMENTS executed;
// it says nothing about which BEHAVIOURS are pinned, and a suite with 100%
// lines and no meaningful assertions scores perfectly while proving nothing.
//
// What this measures instead: a codebase's *enumerable behaviour axes* — the
// closed sets it branches on — and whether each member of each set is
// exercised anywhere in the tests.
//
// Why that framing: two real production bugs found in this repo were both an
// untested CELL in a small closed set, not an untested file.
//   • Stop-on-an-escalation-card left its task stranded in "ongoing" forever.
//     Axis: resolution actions. The `reject` case had a test — it just never
//     asserted the task side.
//   • Archiving a run left it in permanent "review" limbo.
//     Axis: run status × archive. The non-terminal cells were never tried.
// Neither was exotic. Both were a combination nobody enumerated.
//
// Deliberately PURE and string-based (no TypeScript compiler, no toolchain, no
// install step) so it runs against ANY checked-out branch of ANY repo in
// milliseconds, which is what makes it viable as a per-project UI panel rather
// than a CI job.
//
// ── What this is honest about ──────────────────────────────────────────────
// "Covered" here means the member's literal value appears somewhere in the
// test corpus. That is an ASYMMETRIC signal, and the asymmetry is the point:
//   • NOT found  → strong. Nothing in the suite so much as names this case;
//                  it is almost certainly untested.
//   • Found      → weak. It proves mention, not assertion. A value in a
//                  fixture counts as a mention.
// So this is a gap-FINDER, not a quality score. It is built to make the empty
// cells impossible to miss, and it never claims the full ones are well tested.

/** One member of a closed set, and whether the tests mention it at all. */
export interface ScenarioCase {
  value: string;
  covered: boolean;
}

/** A closed set the code branches on — a union type or a zod enum. */
export interface ScenarioAxis {
  /** The declared name, e.g. `EscalationSource`. */
  name: string;
  /** Repo-relative file it was declared in. */
  file: string;
  /** How it was declared — unions and zod enums read differently in review. */
  kind: "union" | "enum";
  cases: ScenarioCase[];
  covered: number;
  total: number;
}

export interface ScenarioReport {
  axes: ScenarioAxis[];
  /** Every `describe`/`it` title found — the behaviours the suite claims. */
  behaviours: string[];
  totalCases: number;
  coveredCases: number;
  /** 0..1. Share of enumerable cases the tests mention at all. */
  ratio: number;
  /** Files scanned, so the UI can say when a scan found nothing to look at. */
  sourceFiles: number;
  testFiles: number;
}

export interface SourceFile {
  /** Repo-relative path. */
  path: string;
  content: string;
}

// Guards against a pathological repo: a generated file with a 500-member union
// would swamp the panel and mean nothing. These are about legibility, not
// correctness — an axis wider than this is not a behaviour set a human reasons
// about case-by-case.
const MAX_CASES_PER_AXIS = 24;
const MIN_CASES_PER_AXIS = 2; // a one-value "set" isn't a decision
const MAX_AXES = 60;

/** Unions written as string literals: `type X = "a" | "b"` (any whitespace). */
const UNION_RE = /(?:export\s+)?type\s+([A-Z]\w*)\s*=\s*([^;{}]+);/g;
/** zod enums: `const X = z.enum(["a", "b"])`. */
const ZOD_ENUM_RE = /(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*z\s*\.\s*enum\s*\(\s*\[([^\]]+)\]/g;
/** `describe("…")` / `it("…")` titles — the suite's own behaviour statements. */
const TITLE_RE = /\b(?:describe|it|test)\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

const literals = (raw: string): string[] | null => {
  // A leading `|` is idiomatic for multi-line unions (`type X =\n  | "a"\n  | "b"`)
  // — and is how this repo's own EscalationSource is written, so dropping it
  // matters more than it looks: without this, the widest real axes are missed.
  const parts = raw.trim().replace(/^\|/, "").split("|").map((p) => p.trim());
  if (parts.length < MIN_CASES_PER_AXIS) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(p);
    if (!m) return null; // any non-literal member → not a closed string set
    const v = m[2]!;
    if (!v) return null;
    out.push(v);
  }
  return out;
};

const quoted = (raw: string): string[] | null => {
  const out = [...raw.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!).filter(Boolean);
  return out.length >= MIN_CASES_PER_AXIS ? out : null;
};

/** PURE: find the closed behaviour sets a repo branches on. */
export function extractAxes(sources: SourceFile[]): Omit<ScenarioAxis, "covered" | "total">[] {
  const axes: Omit<ScenarioAxis, "covered" | "total">[] = [];
  const seen = new Set<string>(); // same name declared twice → keep the first
  for (const f of sources) {
    for (const [re, kind, parse] of [
      [UNION_RE, "union" as const, literals],
      [ZOD_ENUM_RE, "enum" as const, quoted],
    ] as const) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(f.content))) {
        const name = m[1]!;
        if (seen.has(name)) continue;
        const values = parse(m[2]!);
        if (!values || values.length > MAX_CASES_PER_AXIS) continue;
        seen.add(name);
        axes.push({ name, file: f.path, kind, cases: [...new Set(values)].map((value) => ({ value, covered: false })) });
      }
    }
  }
  // Widest sets first: those carry the most untested combinations, and a
  // 9-case axis with 3 gaps is a more useful thing to show than a 2-case one.
  return axes.sort((a, b) => b.cases.length - a.cases.length).slice(0, MAX_AXES);
}

/** PURE: every `describe`/`it` title in the test corpus. */
export function extractBehaviours(tests: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of tests) {
    TITLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TITLE_RE.exec(f.content))) {
      const title = m[2]!.trim();
      if (title) out.push(title);
    }
  }
  return out;
}

/**
 * PURE: cross the repo's behaviour axes against its tests.
 *
 * A case counts as covered when its literal value appears anywhere in the test
 * corpus — quoted, so `"reject"` matches but the substring inside `rejected`
 * does not. See the header: absence is the trustworthy half of this signal.
 */
export function scenarioReport(sources: SourceFile[], tests: SourceFile[]): ScenarioReport {
  const corpus = tests.map((t) => t.content).join("\n");
  const mentions = new Set<string>();
  for (const m of corpus.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const v = m[2]!;
    if (v) mentions.add(v);
  }
  const axes: ScenarioAxis[] = extractAxes(sources).map((a) => {
    const cases = a.cases.map((c) => ({ ...c, covered: mentions.has(c.value) }));
    return { ...a, cases, covered: cases.filter((c) => c.covered).length, total: cases.length };
  });
  const totalCases = axes.reduce((n, a) => n + a.total, 0);
  const coveredCases = axes.reduce((n, a) => n + a.covered, 0);
  return {
    axes,
    behaviours: extractBehaviours(tests),
    totalCases,
    coveredCases,
    ratio: totalCases > 0 ? coveredCases / totalCases : 0,
    sourceFiles: sources.length,
    testFiles: tests.length,
  };
}
