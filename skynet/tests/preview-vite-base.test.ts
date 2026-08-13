// A Vite dev server must be told its base path (`--base=/p/<token>/`) to serve
// behind the live-preview proxy correctly — including cases preview-proxy.ts's
// regex rewriting structurally can't cover (a worker's own runtime
// `import(variable)`, e.g. pdfjs-dist's fake-worker fallback). The recipe most
// projects resolve to is `npm run dev` — the literal word "vite" never appears
// there, only inside the wrapped script body — so injection must look through
// the wrapper, not just string-match the outer command.
import { describe, it, expect } from "vitest";
import { npmRunScriptName, injectViteBase } from "../apps/server/src/preview/project-preview.js";

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
