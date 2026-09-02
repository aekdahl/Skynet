// ─── Roadmap doc provenance enrichment (Phase 26 — TASK 29) ─────────────────
// Fills in RoadmapLine.author/authorRef/addedAt/blameSha at READ time, from
// real git blame — never persisted onto the parsed doc itself, since
// identity.ts's assignLineIdentity resets these fields to null on every
// reparse (only `id` survives a reparse; see its own doc comment). Cheap
// enough to redo per read: one `git blame` + a handful of cached `git log`
// lookups for a single file.
import type { RoadmapAstNode, RoadmapDoc } from "@skynet/shared";
import { blameFile, commitMessage, type LineBlame } from "./blame.js";

const AGENT_COAUTHOR_RE = /Co-authored-by:\s*(.+?)\s*<[^@>]+@agents\.skynet\.local>/i;

/** 1-based starting physical line number for every checklistItem node in
 *  `ast`, in encounter order — computed from each node's own `raw` (the
 *  exact byte span the parser kept, see ast.ts), never re-splitting the
 *  whole doc a second time. */
function checklistLineNumbers(ast: RoadmapAstNode[]): Map<string, number> {
  const out = new Map<string, number>();
  let line = 1;
  for (const node of ast) {
    if (node.type === "checklistItem") out.set(node.id, line);
    // Every node's `raw` ends in exactly the newlines it consumed from the
    // source — count them to advance to the next node's starting line.
    line += (node.raw.match(/\n/g) ?? []).length;
  }
  return out;
}

interface Classified {
  author: string;
  authorRef: string;
}

/** Who a blamed commit is FROM, per attribution.ts's synthetic email
 *  conventions — the only identity scheme this codebase's commits carry.
 *  `skynet@local` (the flat default every ordinary agent-task/Steward commit
 *  uses — see local-repo-write.ts) is treated as machine: it's honestly the
 *  best read of the data (a human never types that email), even though it
 *  can't distinguish WHICH agent without a co-author trailer (see
 *  `resolveAgentCoAuthor` below, tried first for exactly this case). */
export function classifyBlameEmail(email: string): Classified & { isAgent: boolean } {
  const operatorMatch = /^(.+)@operators\.skynet\.local$/.exec(email);
  if (operatorMatch) return { author: operatorMatch[1]!, authorRef: operatorMatch[1]!, isAgent: false };
  if (email === "autonomy@skynet.local") return { author: "Skynet Autonomy", authorRef: "autonomy", isAgent: true };
  const agentMatch = /^(.+)@agents\.skynet\.local$/.exec(email);
  if (agentMatch) return { author: agentMatch[1]!, authorRef: agentMatch[1]!, isAgent: true };
  // skynet@local, or anything else unrecognized — the generic machine identity.
  return { author: "skynet", authorRef: "skynet", isAgent: true };
}

/** For a flat `skynet@local` commit specifically, check whether its message
 *  carries a `Co-authored-by: <agent> <id@agents.skynet.local>` trailer (the
 *  shape `Operations.applyRoadmapProposal` writes) — the one case a specific
 *  agent's identity IS recoverable from an ordinary commit. `shaCache` avoids
 *  a repeat `git log` for the same commit backing multiple lines. */
async function resolveAgentCoAuthor(repoPath: string, sha: string, shaCache: Map<string, string | null>): Promise<string | null> {
  if (shaCache.has(sha)) return shaCache.get(sha)!;
  const message = await commitMessage(repoPath, sha);
  const match = AGENT_COAUTHOR_RE.exec(message);
  const name = match ? match[1]! : null;
  shaCache.set(sha, name);
  return name;
}

/** Returns a NEW doc with every checklistItem's author/authorRef/addedAt/
 *  blameSha filled in from real git blame — best-effort: a doc synced from a
 *  GitHub-only project (no local checkout) or any blame failure leaves the
 *  doc completely unchanged (blameFile itself never throws, returns an empty
 *  map instead — see its own doc comment), so this is always safe to call. */
export async function enrichRoadmapDocWithBlame(doc: RoadmapDoc, repoPath: string): Promise<RoadmapDoc> {
  const blame = await blameFile(repoPath, doc.path);
  if (blame.size === 0) return doc;
  const lineNumbers = checklistLineNumbers(doc.ast);
  const coAuthorCache = new Map<string, string | null>();

  const ast = await Promise.all(
    doc.ast.map(async (node) => {
      if (node.type !== "checklistItem") return node;
      const lineNo = lineNumbers.get(node.id);
      const b: LineBlame | undefined = lineNo != null ? blame.get(lineNo) : undefined;
      if (!b) return node;
      const classified = classifyBlameEmail(b.authorEmail);
      let author = classified.author;
      let authorRef = classified.authorRef;
      // The flat-identity case is the common one for ordinary agent work — see
      // classifyBlameEmail's own comment — worth the extra lookup to name the
      // real agent when a proposal-apply commit's trailer has it.
      if (authorRef === "skynet") {
        const agentName = await resolveAgentCoAuthor(repoPath, b.sha, coAuthorCache);
        if (agentName) {
          author = agentName;
          authorRef = agentName;
        }
      }
      return {
        ...node,
        author,
        authorRef,
        addedAt: b.authorTimeSec * 1000,
        blameSha: b.sha,
        claimedByHuman: !classified.isAgent,
      };
    }),
  );
  return { ...doc, ast };
}
