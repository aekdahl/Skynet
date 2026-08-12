// ─── Unified diff builder ────────────────────────────────────────────────────
// PURE. Builds a unified-diff patch string from a before/after pair of text —
// used to show the operator a real diff of a Steward-drafted roadmap edit
// before they confirm it. No diff library exists anywhere in this repo; this
// is a small line-based LCS diff (O(n·m) DP), which is trivial cost for the
// few-hundred-line docs this is built for. Output format matches exactly what
// the web client's DiffView / parseUnifiedDiff expects (diff-view.tsx):
// a `diff --git a/<path> b/<path>` line, `@@ -a,b +c,d @@` hunk headers, and
// space/`+`/`-`-prefixed lines.

const CONTEXT = 3;

type Op = { type: "ctx" | "add" | "del"; line: string };

/** Longest-common-subsequence line alignment → a full add/del/ctx op script. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the LCS of a[i:] and b[j:]
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

export function buildUnifiedDiff(path: string, before: string, after: string): { patch: string; add: number; del: number } {
  if (before === after) return { patch: "", add: 0, del: 0 };

  const ops = diffLines(before.split("\n"), after.split("\n"));
  const add = ops.reduce((n, o) => n + (o.type === "add" ? 1 : 0), 0);
  const del = ops.reduce((n, o) => n + (o.type === "del" ? 1 : 0), 0);
  if (add === 0 && del === 0) return { patch: "", add: 0, del: 0 };

  // 1-based old/new line number at each op index, for hunk headers.
  const oldAt: number[] = new Array(ops.length);
  const newAt: number[] = new Array(ops.length);
  let oldNo = 1;
  let newNo = 1;
  ops.forEach((o, idx) => {
    oldAt[idx] = oldNo;
    newAt[idx] = newNo;
    if (o.type !== "add") oldNo++;
    if (o.type !== "del") newNo++;
  });

  // Cluster changed ops whose gap is within 2*CONTEXT (git's own hunk-merge rule).
  const changedIdx = ops.flatMap((o, idx) => (o.type === "ctx" ? [] : [idx]));
  const clusters: [number, number][] = [];
  let curStart = changedIdx[0]!;
  let curEnd = changedIdx[0]!;
  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k]!;
    if (idx - curEnd <= 2 * CONTEXT) curEnd = idx;
    else {
      clusters.push([curStart, curEnd]);
      curStart = idx;
      curEnd = idx;
    }
  }
  clusters.push([curStart, curEnd]);

  const out: string[] = [`diff --git a/${path} b/${path}`];
  for (const [cs, ce] of clusters) {
    const lo = Math.max(0, cs - CONTEXT);
    const hi = Math.min(ops.length - 1, ce + CONTEXT);
    let oldLen = 0;
    let newLen = 0;
    for (let k = lo; k <= hi; k++) {
      if (ops[k]!.type !== "add") oldLen++;
      if (ops[k]!.type !== "del") newLen++;
    }
    out.push(`@@ -${oldAt[lo]},${oldLen} +${newAt[lo]},${newLen} @@`);
    for (let k = lo; k <= hi; k++) {
      const o = ops[k]!;
      out.push((o.type === "add" ? "+" : o.type === "del" ? "-" : " ") + o.line);
    }
  }
  return { patch: out.join("\n"), add, del };
}
