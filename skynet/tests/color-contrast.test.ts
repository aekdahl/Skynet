// Text-contrast ramp — "checked ratios" (ROADMAP.md, Product v1.5). Reads the
// REAL token values back out of apps/web/src/styles.css (never hand-copies
// them) so a future edit that quietly weakens a color can't drift silently
// past the comment's own claims — this is the enforcement, not just a note.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../apps/web/src/styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

// Pulls `--token: #RRGGBB;` out of the :root block. Restricted to a plain hex
// literal — every token this test cares about is a literal color, not a
// var()/color-mix() reference — so a token that stops being a literal makes
// this throw loudly instead of silently checking the wrong thing.
function tokenHex(name: string): string {
  const m = styles.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`));
  if (!m) throw new Error(`--${name} not found (or not a plain hex literal) in styles.css`);
  return m[1]!;
}

// WCAG 2.x relative luminance + contrast ratio — the standard formula
// (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance), no library needed.
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("main text-contrast ramp vs --bg", () => {
  const bg = tokenHex("bg");

  it("--text clears the AAA floor (7:1) for sustained body reading", () => {
    expect(contrastRatio(tokenHex("text"), bg)).toBeGreaterThanOrEqual(7);
  });

  it("--muted clears the AA floor (4.5:1) for secondary labels", () => {
    expect(contrastRatio(tokenHex("muted"), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("--faint clears the large-text/decorative floor (3:1) — never used for body copy", () => {
    expect(contrastRatio(tokenHex("faint"), bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("Automated Kanban surface's own text-contrast ramp vs --ak-canvas", () => {
  const canvas = tokenHex("ak-canvas");

  it("--ak-text-primary clears the AAA floor (7:1)", () => {
    expect(contrastRatio(tokenHex("ak-text-primary"), canvas)).toBeGreaterThanOrEqual(7);
  });

  it("--ak-text-secondary clears the AA floor (4.5:1)", () => {
    expect(contrastRatio(tokenHex("ak-text-secondary"), canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("--ak-text-muted clears the AA floor (4.5:1)", () => {
    expect(contrastRatio(tokenHex("ak-text-muted"), canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("--ak-text-faint clears the large-text/decorative floor (3:1)", () => {
    expect(contrastRatio(tokenHex("ak-text-faint"), canvas)).toBeGreaterThanOrEqual(3);
  });
});
