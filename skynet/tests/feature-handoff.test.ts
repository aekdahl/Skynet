// Pure unit coverage for feature-handoff.ts's prompt/reply helpers — the
// non-classifying cleanup (strip an accidental fence, reject a degenerate
// reply) and the deterministic CHANGELOG.md splice. No I/O, no consult call.
import { describe, it, expect } from "vitest";
import {
  parseChangeManagerReply,
  spliceChangelogEntry,
  parseDocsWriterReply,
  parseReleaseCommsReply,
} from "../apps/server/src/feature-handoff.js";

describe("parseChangeManagerReply", () => {
  it("returns a plausible reply as-is", () => {
    expect(parseChangeManagerReply("## Cross-vendor bake-offs\n\n- Peer review lands.")).toBe(
      "## Cross-vendor bake-offs\n\n- Peer review lands.",
    );
  });
  it("strips an accidental outer code fence", () => {
    expect(parseChangeManagerReply("```\n- A real entry, fenced anyway.\n```")).toBe("- A real entry, fenced anyway.");
  });
  it("rejects a degenerate (too-short) reply", () => {
    expect(parseChangeManagerReply("ok")).toBeNull();
  });
  it("rejects a runaway (too-long) reply", () => {
    expect(parseChangeManagerReply("x".repeat(5000))).toBeNull();
  });
});

describe("spliceChangelogEntry", () => {
  it("scaffolds a fresh file when none exists yet", () => {
    expect(spliceChangelogEntry(null, "- New entry")).toBe("# Changelog\n\n- New entry\n");
  });
  it("inserts right after the first heading + its blank line", () => {
    const current = "# Changelog\n\n## v1.4\n- old entry\n";
    expect(spliceChangelogEntry(current, "## v1.5\n- new entry")).toBe("# Changelog\n\n## v1.5\n- new entry\n\n## v1.4\n- old entry\n");
  });
  it("prepends at the top when no heading is found", () => {
    expect(spliceChangelogEntry("just some prose, no heading\n", "- new entry")).toBe("- new entry\n\njust some prose, no heading\n");
  });
});

describe("parseDocsWriterReply", () => {
  const baseline = "# Skynet\n\nA fleet of coding agents.\n".repeat(3);
  it("accepts a plausibly-sized replacement", () => {
    const reply = baseline + "\n- New feature bullet.";
    expect(parseDocsWriterReply(reply, baseline)).toBe(reply);
  });
  it("rejects a wildly shorter reply (likely truncated)", () => {
    expect(parseDocsWriterReply("# Skynet", baseline)).toBeNull();
  });
  it("rejects a wildly longer reply (likely runaway)", () => {
    expect(parseDocsWriterReply(baseline.repeat(10), baseline)).toBeNull();
  });
  it("skips the size-ratio check when there's no baseline to compare against", () => {
    expect(parseDocsWriterReply("# Skynet\n\nBrand new README.", null)).toBe("# Skynet\n\nBrand new README.");
  });
});

describe("parseReleaseCommsReply", () => {
  it("accepts a plausible announcement", () => {
    expect(parseReleaseCommsReply("Agents now peer-review each other's bake-off diffs.")).toBe(
      "Agents now peer-review each other's bake-off diffs.",
    );
  });
  it("rejects an empty/degenerate reply", () => {
    expect(parseReleaseCommsReply("...")).toBeNull();
  });
});
