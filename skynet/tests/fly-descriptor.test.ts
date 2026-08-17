// Pure-function coverage for the Fly deploy descriptor/config resolution —
// app-name derivation + collision handling, descriptor parsing, and the
// generated fly.toml/Dockerfile for the static-site path. None of this needs
// flyctl or a real Fly account (see apps/server/src/fly/descriptor.ts).
import { describe, it, expect } from "vitest";
import {
  deriveFlyAppName,
  FLY_DEFAULT_MEMORY,
  FLY_DEFAULT_REGION,
  FLY_DEFAULT_SIZE,
  generateFlyToml,
  generateStaticDockerfile,
  nextAppNameAttempt,
  parseFlyDescriptor,
  resolveFlyConfig,
  slugifyAppName,
  stableSuffix,
} from "../apps/server/src/fly/descriptor.js";

describe("slugifyAppName", () => {
  it("lowercases and dashes non-alphanumeric runs", () => {
    expect(slugifyAppName("My Cool App!!")).toBe("my-cool-app");
  });
  it("strips leading/trailing dashes", () => {
    expect(slugifyAppName("--edge case--")).toBe("edge-case");
  });
  it("prefixes a leading digit (Fly app names must start with a letter)", () => {
    expect(slugifyAppName("42 problems")).toBe("app-42-problems");
  });
  it("falls back to a non-empty name for pure punctuation", () => {
    expect(slugifyAppName("!!!")).toBe("app");
  });
  it("caps length so a collision suffix always fits", () => {
    const long = "a".repeat(200);
    expect(slugifyAppName(long).length).toBeLessThanOrEqual(40);
  });
});

describe("stableSuffix + deriveFlyAppName", () => {
  it("is deterministic for the same seed", () => {
    expect(stableSuffix("proj-123")).toBe(stableSuffix("proj-123"));
  });
  it("differs for different seeds", () => {
    expect(stableSuffix("proj-123")).not.toBe(stableSuffix("proj-456"));
  });
  it("derives the same app name across repeated calls (idempotent redeploys, one app)", () => {
    const a = deriveFlyAppName("Acme Storefront", "proj-abc");
    const b = deriveFlyAppName("Acme Storefront", "proj-abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^acme-storefront-[0-9a-f]{8}$/);
  });
  it("gives two different projects with the SAME name different app names", () => {
    const a = deriveFlyAppName("Storefront", "proj-1");
    const b = deriveFlyAppName("Storefront", "proj-2");
    expect(a).not.toBe(b);
  });
});

describe("nextAppNameAttempt (collision retry)", () => {
  it("bumps deterministically", () => {
    expect(nextAppNameAttempt("acme-ab12cd34", 0)).toBe("acme-ab12cd34-1");
    expect(nextAppNameAttempt("acme-ab12cd34", 1)).toBe("acme-ab12cd34-2");
  });
});

describe("parseFlyDescriptor", () => {
  it("reads the fly sub-block plus the shared build/outputDir fields", () => {
    const raw = { build: "npm run build", outputDir: "build", fly: { app: "custom-app", region: "lhr", size: "shared-cpu-2x", memory: "512mb", org: "acme" } };
    const parsed = parseFlyDescriptor(raw);
    expect(parsed.build).toBe("npm run build");
    expect(parsed.outputDir).toBe("build");
    expect(parsed.fly).toEqual({ app: "custom-app", region: "lhr", size: "shared-cpu-2x", memory: "512mb", org: "acme" });
  });
  it("tolerates a missing fly block entirely", () => {
    const parsed = parseFlyDescriptor({ dev: "npm run dev" });
    expect(parsed.fly).toEqual({ app: undefined, region: undefined, size: undefined, memory: undefined, org: undefined });
    expect(parsed.build).toBeNull();
  });
  it("tolerates null input (no descriptor file at all)", () => {
    const parsed = parseFlyDescriptor(null);
    expect(parsed.build).toBeNull();
    expect(parsed.outputDir).toBeNull();
  });
  it("ignores a malformed fly block (wrong type) rather than throwing", () => {
    const parsed = parseFlyDescriptor({ fly: "not an object" });
    expect(parsed.fly).toEqual({ app: undefined, region: undefined, size: undefined, memory: undefined, org: undefined });
  });
  it("ignores blank-string overrides (falls through to defaults downstream)", () => {
    const parsed = parseFlyDescriptor({ fly: { region: "   " } });
    expect(parsed.fly.region).toBeUndefined();
  });
});

describe("resolveFlyConfig", () => {
  it("applies small/free-tier defaults when the descriptor is absent", () => {
    const cfg = resolveFlyConfig({ raw: null, projectName: "Demo", projectId: "p1" });
    expect(cfg.region).toBe(FLY_DEFAULT_REGION);
    expect(cfg.size).toBe(FLY_DEFAULT_SIZE);
    expect(cfg.memory).toBe(FLY_DEFAULT_MEMORY);
    expect(cfg.org).toBeNull();
    expect(cfg.buildCmd).toBeNull();
    expect(cfg.outputDir).toBe("dist"); // default even though unused when buildCmd is null
  });
  it("an explicit fly.app always wins over the derived name", () => {
    const cfg = resolveFlyConfig({ raw: { fly: { app: "pinned-name" } }, projectName: "Demo", projectId: "p1" });
    expect(cfg.appName).toBe("pinned-name");
  });
  it("descriptor overrides every default, field by field", () => {
    const cfg = resolveFlyConfig({
      raw: { build: "npm run build", outputDir: "out", fly: { region: "syd", size: "shared-cpu-4x", memory: "1gb", org: "acme" } },
      projectName: "Demo",
      projectId: "p1",
    });
    expect(cfg).toMatchObject({ region: "syd", size: "shared-cpu-4x", memory: "1gb", org: "acme", buildCmd: "npm run build", outputDir: "out" });
  });
});

describe("generateFlyToml / generateStaticDockerfile (static-site path)", () => {
  it("produces a toml with the app name, region, and a cost-safe idle policy", () => {
    const toml = generateFlyToml({ appName: "my-app-ab12cd34", region: "iad", size: "shared-cpu-1x", memory: "256mb" });
    expect(toml).toContain('app = "my-app-ab12cd34"');
    expect(toml).toContain('primary_region = "iad"');
    expect(toml).toContain("internal_port = 80"); // matches the Dockerfile's nginx EXPOSE 80
    expect(toml).toContain("min_machines_running = 0"); // idle → no compute burned
    expect(toml).toContain('size = "shared-cpu-1x"');
    expect(toml).toContain('memory = "256mb"');
  });
  it("the Dockerfile serves outputDir on the SAME port the toml expects", () => {
    const dockerfile = generateStaticDockerfile("dist");
    expect(dockerfile).toContain("COPY dist /usr/share/nginx/html");
    expect(dockerfile).toContain("EXPOSE 80");
  });
});
