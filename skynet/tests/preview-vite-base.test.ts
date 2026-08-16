// A Vite dev server must be told its base path (`--base=/p/<token>/`) to serve
// behind the live-preview proxy correctly — including cases preview-proxy.ts's
// regex rewriting structurally can't cover (a worker's own runtime
// `import(variable)`, e.g. pdfjs-dist's fake-worker fallback). The recipe most
// projects resolve to is `npm run dev` — the literal word "vite" never appears
// there, only inside the wrapped script body — so injection must look through
// the wrapper, not just string-match the outer command.
import { describe, it, expect } from "vitest";
import { npmRunScriptName, injectViteBase, injectViteFsAllow, viteFsAllowConfigSource } from "../apps/server/src/preview/project-preview.js";

describe("npmRunScriptName", () => {
  it("extracts the script name from an npm run command", () => {
    expect(npmRunScriptName("npm run dev")).toBe("dev");
    expect(npmRunScriptName("npm run start")).toBe("start");
  });
  it("returns null for a non-npm-run command", () => {
    expect(npmRunScriptName("vite --host")).toBeNull();
    expect(npmRunScriptName("yarn dev")).toBeNull();
  });
});

describe("injectViteBase", () => {
  it("injects through an npm run wrapper when the wrapped script is Vite", () => {
    const { cmd, injected } = injectViteBase({ cmd: "npm run dev", wrappedScript: "vite" }, "abc123", true);
    expect(injected).toBe(true);
    expect(cmd).toBe("npm run dev -- --base=/p/abc123/");
  });
  it("injects directly (no --) when the command itself is Vite", () => {
    const { cmd, injected } = injectViteBase({ cmd: "vite --host" }, "abc123", true);
    expect(injected).toBe(true);
    expect(cmd).toBe("vite --host --base=/p/abc123/");
  });
  it("does not inject when there's no public origin (desktop/local, no proxy)", () => {
    const { cmd, injected } = injectViteBase({ cmd: "npm run dev", wrappedScript: "vite" }, "abc123", false);
    expect(injected).toBe(false);
    expect(cmd).toBe("npm run dev");
  });
  it("does not inject when the wrapped script isn't Vite (e.g. next dev)", () => {
    const { injected } = injectViteBase({ cmd: "npm run dev", wrappedScript: "next dev" }, "abc123", true);
    expect(injected).toBe(false);
  });
  it("does not inject when an npm run wrapper's script body is unknown", () => {
    const { injected } = injectViteBase({ cmd: "npm run dev" }, "abc123", true);
    expect(injected).toBe(false);
  });
  it("does not inject when a base is already set", () => {
    const { injected: a } = injectViteBase({ cmd: "npm run dev", wrappedScript: "vite --base=/custom/" }, "abc123", true);
    expect(a).toBe(false);
    const { injected: b } = injectViteBase({ cmd: "vite --base=/custom/" }, "abc123", true);
    expect(b).toBe(false);
  });
});

// `ensureDeps`'s node_modules symlink (the fast path that avoids a slow
// reinstall) resolves outside the preview worktree, past Vite's fs.allow
// boundary — so a /@fs/ reference into it 403s even with the base fix above
// (verified live: pdfjs-dist's pdf.worker load succeeded once the token
// prefix was correct, but still 403'd on the symlinked node_modules path).
describe("injectViteFsAllow", () => {
  const CFG = "/worktree/.skynet-preview.vite.config.mjs";

  it("injects through an npm run wrapper when node_modules is symlinked", () => {
    const { cmd, injected } = injectViteFsAllow({ cmd: "npm run dev", wrappedScript: "vite" }, "npm run dev", CFG, true);
    expect(injected).toBe(true);
    expect(cmd).toBe(`npm run dev -- --config "${CFG}"`);
  });
  it("injects directly (no --) when the command itself is Vite", () => {
    const { cmd, injected } = injectViteFsAllow({ cmd: "vite --host" }, "vite --host", CFG, true);
    expect(injected).toBe(true);
    expect(cmd).toBe(`vite --host --config "${CFG}"`);
  });
  it("reuses an existing -- separator instead of adding a second one", () => {
    const { cmd, injected } = injectViteFsAllow(
      { cmd: "npm run dev", wrappedScript: "vite" },
      "npm run dev -- --base=/p/abc123/",
      CFG,
      true,
    );
    expect(injected).toBe(true);
    expect(cmd).toBe(`npm run dev -- --base=/p/abc123/ --config "${CFG}"`);
  });
  it("does not inject when node_modules isn't a symlink (nothing outside the worktree to allow)", () => {
    const { cmd, injected } = injectViteFsAllow({ cmd: "npm run dev", wrappedScript: "vite" }, "npm run dev", CFG, false);
    expect(injected).toBe(false);
    expect(cmd).toBe("npm run dev");
  });
  it("does not inject when the wrapped script isn't Vite", () => {
    const { injected } = injectViteFsAllow({ cmd: "npm run dev", wrappedScript: "next dev" }, "npm run dev", CFG, true);
    expect(injected).toBe(false);
  });
  it("does not inject when a --config is already set", () => {
    const { injected } = injectViteFsAllow({ cmd: "vite --config ./vite.custom.js" }, "vite --config ./vite.custom.js", CFG, true);
    expect(injected).toBe(false);
  });
});

describe("viteFsAllowConfigSource", () => {
  it("embeds the extra allow paths and loads+merges the project's own config", () => {
    const src = viteFsAllowConfigSource(["/original/repo"]);
    expect(src).toContain('"/original/repo"');
    expect(src).toContain("loadConfigFromFile");
    expect(src).toContain("mergeConfig");
  });
  it("always includes the worktree root itself, not just the extra paths", () => {
    // Explicitly setting fs.allow REPLACES Vite's own default (the worktree
    // root) rather than extending it — omitting "." here would 403 the
    // worktree's own files (index.html, main.js, …), not just fix node_modules.
    const src = viteFsAllowConfigSource(["/original/repo"]);
    expect(src).toContain('["."');
  });
});
