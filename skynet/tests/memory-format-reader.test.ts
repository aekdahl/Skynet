// v4: reader for the Skynet Open Memory Format (docs/memory-format.md) — the
// git-committable `.skynet/memory/` layout. Read-only: no writer, no MCP
// surface yet (tracked separately). Pins the parser against the exact
// examples in the spec doc, plus the compatibility rules it promises
// (tolerate unknown frontmatter/fact-metadata keys, never error on them).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMemoryFile,
  readMemoryFile,
  readWorkspaceMemory,
  currentFacts,
} from "../apps/server/src/memory-format-reader.js";

const SPEC_EXAMPLE = `---
skynet_memory_version: 0.1
scope: project
project: acme-web
---

## Prefer snake_case for Python files
<!-- skynet:fact id=01J6ZQMFH2K9V4X3 source=operator author=jordan created=2026-08-12T14:03:00Z confidence=stated -->

Stated directly by an operator approving a diff gate in the HITL Inbox.

## Review changes touching the billing webhook route closely
<!-- skynet:fact id=01J6ZRA1P7WYB0FQ source=decision run=run_9f2 hitl=q42 author=jordan created=2026-07-30T09:12:00Z confidence=derived -->

Derived from an \`approve\` decision whose guidance said a June regression
silently broke the billing webhook — the operator wants closer review of
that area going forward.
`;

describe("parseMemoryFile", () => {
  it("parses frontmatter and both facts from the spec's own example", () => {
    const file = parseMemoryFile(SPEC_EXAMPLE);

    expect(file.frontmatter.skynet_memory_version).toBe("0.1");
    expect(file.frontmatter.scope).toBe("project");
    expect(file.frontmatter.project).toBe("acme-web");
    expect(file.frontmatter.extra).toEqual({});

    expect(file.facts).toHaveLength(2);
    const [f1, f2] = file.facts;

    expect(f1.heading).toBe("Prefer snake_case for Python files");
    expect(f1.id).toBe("01J6ZQMFH2K9V4X3");
    expect(f1.source).toBe("operator");
    expect(f1.author).toBe("jordan");
    expect(f1.created).toBe("2026-08-12T14:03:00Z");
    expect(f1.confidence).toBe("stated");
    expect(f1.run).toBeUndefined();
    expect(f1.body).toBe("Stated directly by an operator approving a diff gate in the HITL Inbox.");

    expect(f2.heading).toBe("Review changes touching the billing webhook route closely");
    expect(f2.source).toBe("decision");
    expect(f2.run).toBe("run_9f2");
    expect(f2.hitl).toBe("q42");
    expect(f2.body).toContain("Derived from an `approve` decision");
  });

  it("tolerates unknown frontmatter and fact-metadata keys, carrying them as extra", () => {
    const content = `---
skynet_memory_version: 0.1
scope: workspace
future_field: something-new
---

## A fact from a newer tool
<!-- skynet:fact id=abc source=operator author=jordan created=2026-01-01T00:00:00Z confidence=stated experimental_flag=true -->

Body text.
`;
    const file = parseMemoryFile(content);
    expect(file.frontmatter.extra).toEqual({ future_field: "something-new" });
    expect(file.facts[0].extra).toEqual({ experimental_flag: "true" });
    expect(file.facts[0].id).toBe("abc");
  });

  it("returns no facts (not an error) for a frontmatter-only file", () => {
    const file = parseMemoryFile("---\nskynet_memory_version: 0.1\nscope: workspace\n---\n");
    expect(file.facts).toEqual([]);
  });

  it("treats a file with no frontmatter as empty frontmatter, still parsing facts", () => {
    const file = parseMemoryFile("## A fact with no frontmatter\n<!-- skynet:fact id=x source=operator author=a created=2026-01-01T00:00:00Z confidence=stated -->\n\nBody.\n");
    expect(file.frontmatter.scope).toBeUndefined();
    expect(file.facts).toHaveLength(1);
    expect(file.facts[0].id).toBe("x");
  });

  it("doesn't error on a fact block missing the metadata comment", () => {
    const file = parseMemoryFile("## Hand-written fact, no comment yet\n\nJust prose.\n");
    expect(file.facts).toHaveLength(1);
    expect(file.facts[0].id).toBe("");
    expect(file.facts[0].body).toBe("Just prose.");
  });
});

describe("currentFacts", () => {
  it("drops a fact once another fact supersedes it, keeping the superseding one", () => {
    const file = parseMemoryFile(`---
scope: workspace
---

## Old guidance
<!-- skynet:fact id=old1 source=operator author=jordan created=2026-01-01T00:00:00Z confidence=stated -->

Stale.

## New guidance
<!-- skynet:fact id=new1 source=operator author=jordan created=2026-02-01T00:00:00Z confidence=stated supersedes=old1 -->

Current.
`);
    const current = currentFacts(file.facts);
    expect(current.map((f) => f.id)).toEqual(["new1"]);
  });

  it("keeps all facts when nothing supersedes anything", () => {
    const file = parseMemoryFile(SPEC_EXAMPLE);
    expect(currentFacts(file.facts)).toHaveLength(2);
  });
});

describe("readMemoryFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-format-reader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a file that doesn't exist", async () => {
    expect(await readMemoryFile(join(dir, "nope.md"))).toBeNull();
  });

  it("reads and parses a real file from disk", async () => {
    const path = join(dir, "workspace.md");
    writeFileSync(path, SPEC_EXAMPLE);
    const file = await readMemoryFile(path, "workspace.md");
    expect(file?.path).toBe("workspace.md");
    expect(file?.facts).toHaveLength(2);
  });
});

describe("readWorkspaceMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-format-reader-workspace-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty array when the workspace has no memory yet", async () => {
    expect(await readWorkspaceMemory(dir)).toEqual([]);
  });

  it("reads workspace, project, area, and agent scopes, skipping MEMORY.md", async () => {
    const base = join(dir, ".skynet", "memory");
    mkdirSync(join(base, "projects"), { recursive: true });
    mkdirSync(join(base, "areas", "acme-web"), { recursive: true });
    mkdirSync(join(base, "agents"), { recursive: true });

    writeFileSync(join(base, "MEMORY.md"), "- [Workspace](workspace.md) — org-wide facts\n");
    writeFileSync(join(base, "workspace.md"), "---\nscope: workspace\n---\n\n## Fact A\n<!-- skynet:fact id=a source=operator author=j created=2026-01-01T00:00:00Z confidence=stated -->\n");
    writeFileSync(join(base, "projects", "acme-web.md"), "---\nscope: project\nproject: acme-web\n---\n\n## Fact B\n<!-- skynet:fact id=b source=operator author=j created=2026-01-01T00:00:00Z confidence=stated -->\n");
    writeFileSync(join(base, "areas", "acme-web", "billing.md"), "---\nscope: area\nproject: acme-web\narea: billing\n---\n\n## Fact C\n<!-- skynet:fact id=c source=operator author=j created=2026-01-01T00:00:00Z confidence=stated -->\n");
    writeFileSync(join(base, "agents", "claude.md"), "---\nscope: agent\nagent_family: claude\n---\n\n## Fact D\n<!-- skynet:fact id=d source=operator author=j created=2026-01-01T00:00:00Z confidence=stated -->\n");

    const files = await readWorkspaceMemory(dir);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      join("agents", "claude.md"),
      join("areas", "acme-web", "billing.md"),
      join("projects", "acme-web.md"),
      "workspace.md",
    ].sort());

    const allFacts = files.flatMap((f) => f.facts.map((fact) => fact.id));
    expect(allFacts.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("only creates the directories a workspace actually uses (partial layout is fine)", async () => {
    const base = join(dir, ".skynet", "memory");
    mkdirSync(join(base, "projects"), { recursive: true });
    writeFileSync(join(base, "projects", "solo.md"), "---\nscope: project\nproject: solo\n---\n");

    const files = await readWorkspaceMemory(dir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(join("projects", "solo.md"));
  });
});
