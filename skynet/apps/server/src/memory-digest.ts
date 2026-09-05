// ─── Memory digest (Memory v0, phase 1) ─────────────────────────────────────
// Turns a project's CURRENT facts (memory-format-reader.ts's currentFacts —
// supersessions already dropped) into the compact prompt text
// agent-context.ts's `memory` section renders. Pure — no store/repo access —
// so it's unit-testable directly against fixture facts.

import type { MemoryFact } from "./memory-format-reader.js";

// A digest is grounding, not a transcript — capped the same spirit as
// agent-context.ts's other optional sections (siblings, primer).
const MAX_FACTS = 30;
const BODY_CHAR_CAP = 200;

/**
 * One bullet per fact: the heading (the fact itself, in the spec's own
 * words), plus a capped one-line body if the operator added elaboration.
 * `label` distinguishes which file the facts came from ("workspace"/the
 * project's own name/an agent family) since a combined digest draws from
 * more than one source file.
 */
export function factsDigest(sections: Array<{ label: string; facts: MemoryFact[] }>): string | undefined {
  const lines: string[] = [];
  for (const { label, facts } of sections) {
    const capped = facts.slice(0, MAX_FACTS);
    if (capped.length === 0) continue;
    lines.push(`[${label}]`);
    for (const f of capped) {
      const body = f.body.trim();
      const bodySuffix = body ? ` — ${body.length > BODY_CHAR_CAP ? `${body.slice(0, BODY_CHAR_CAP)}…` : body}` : "";
      lines.push(`- ${f.heading}${bodySuffix}`);
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}
