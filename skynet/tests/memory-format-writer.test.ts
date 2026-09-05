// Memory v0, phase 1: the writer half of the Skynet Open Memory Format
// (docs/memory-format.md). Pure round-trip tests against the existing reader
// — appendFact's whole job is producing text parseMemoryFile reads back
// correctly, and never touching bytes it didn't add.
import { describe, it, expect } from "vitest";
import { appendFact, newMemoryFileHeader, type NewFactInput } from "../apps/server/src/memory-format-writer.js";
import { parseMemoryFile, currentFacts } from "../apps/server/src/memory-format-reader.js";

const FACT: NewFactInput = {
  id: "fact-1",
  heading: "Prefer snake_case for Python files",
  body: "Stated directly by an operator approving a diff gate in the HITL Inbox.",
  source: "operator",
  author: "jordan",
  created: "2026-08-12T14:03:00Z",
  confidence: "stated",
};

describe("appendFact — round-trips through parseMemoryFile", () => {
  it("a brand-new file: header + one fact, parsed back exactly", () => {
    const header = newMemoryFileHeader("project", { project: "acme-web" });
    const content = appendFact("", FACT, header);
    const parsed = parseMemoryFile(content);

    expect(parsed.frontmatter.scope).toBe("project");
    expect(parsed.frontmatter.project).toBe("acme-web");
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]).toMatchObject({
      heading: "Prefer snake_case for Python files",
      body: "Stated directly by an operator approving a diff gate in the HITL Inbox.",
      id: "fact-1",
      source: "operator",
      author: "jordan",
      created: "2026-08-12T14:03:00Z",
      confidence: "stated",
    });
  });

  it("appending a second fact preserves the first one exactly, byte for byte", () => {
    const header = newMemoryFileHeader("workspace");
    let content = appendFact("", FACT, header);
    content = appendFact(content, { ...FACT, id: "fact-2", heading: "Second fact", body: "" });

    const parsed = parseMemoryFile(content);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[0]?.id).toBe("fact-1");
    expect(parsed.facts[0]?.heading).toBe("Prefer snake_case for Python files");
    expect(parsed.facts[1]?.id).toBe("fact-2");
    expect(parsed.facts[1]?.heading).toBe("Second fact");
    expect(parsed.facts[1]?.body).toBe("");
  });

  it("never touches existing hand-written content — appends after it untouched", () => {
    const handWritten = `---\nskynet_memory_version: 0.1\nscope: workspace\n---\n\n## A hand-typed fact\n<!-- skynet:fact id=h1 source=operator author=me created=2026-01-01T00:00:00Z confidence=stated custom_key=kept -->\n\nSome prose.\n`;
    const content = appendFact(handWritten, { ...FACT, id: "fact-2" });

    // The original bytes are all still there, unchanged.
    expect(content.startsWith(handWritten.trimEnd())).toBe(true);

    const parsed = parseMemoryFile(content);
    expect(parsed.facts).toHaveLength(2);
    // Unknown fact-metadata key preserved verbatim (spec's compatibility rule).
    expect(parsed.facts[0]?.extra).toEqual({ custom_key: "kept" });
    expect(parsed.facts[1]?.id).toBe("fact-2");
  });

  it("quotes a metadata value containing whitespace, and it still parses back", () => {
    const content = appendFact("", { ...FACT, author: "jordan smith" }, newMemoryFileHeader("workspace"));
    const parsed = parseMemoryFile(content);
    expect(parsed.facts[0]?.author).toBe("jordan smith");
  });

  it("a supersedes reference round-trips, and currentFacts drops the superseded one", () => {
    let content = appendFact("", FACT, newMemoryFileHeader("workspace"));
    content = appendFact(content, { ...FACT, id: "fact-2", heading: "Corrected fact", supersedes: "fact-1" });

    const parsed = parseMemoryFile(content);
    expect(parsed.facts[1]?.supersedes).toBe("fact-1");
    const current = currentFacts(parsed.facts);
    expect(current.map((f) => f.id)).toEqual(["fact-2"]);
  });

  it("an empty body serializes as just the heading + metadata comment, no dangling blank body", () => {
    const content = appendFact("", { ...FACT, body: "" }, newMemoryFileHeader("workspace"));
    const parsed = parseMemoryFile(content);
    expect(parsed.facts[0]?.body).toBe("");
  });
});

describe("newMemoryFileHeader", () => {
  it("includes only the fields relevant to the given scope", () => {
    expect(parseMemoryFile(newMemoryFileHeader("workspace")).frontmatter).toMatchObject({ scope: "workspace" });
    expect(parseMemoryFile(newMemoryFileHeader("project", { project: "p1" })).frontmatter).toMatchObject({ scope: "project", project: "p1" });
    expect(parseMemoryFile(newMemoryFileHeader("area", { project: "p1", area: "billing" })).frontmatter).toMatchObject({
      scope: "area", project: "p1", area: "billing",
    });
    expect(parseMemoryFile(newMemoryFileHeader("agent", { agentFamily: "claude" })).frontmatter).toMatchObject({
      scope: "agent", agent_family: "claude",
    });
  });
});
