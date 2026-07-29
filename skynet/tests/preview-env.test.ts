// previewEnv builds the environment for preview subprocesses (dependency install
// + the dev server). The bug it guards: a production server (NODE_ENV=production,
// as on staging) makes `npm install` skip devDependencies, so tooling the dev
// script needs (concurrently, vite, …) is never installed and `npm run dev` fails
// with "<tool>: not found". A preview is a DEV run, so the env must force
// NODE_ENV=development regardless of the server's own env.
import { describe, it, expect, afterEach } from "vitest";
import { previewEnv } from "../apps/server/src/preview/project-preview.js";

describe("previewEnv (preview subprocess env)", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    prod: process.env.npm_config_production,
    omit: process.env.npm_config_omit,
  };
  const restore = (key: string, val: string | undefined) => {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  };
  afterEach(() => {
    restore("NODE_ENV", saved.NODE_ENV);
    restore("npm_config_production", saved.prod);
    restore("npm_config_omit", saved.omit);
    delete process.env.SOME_PREVIEW_MARKER;
  });

  it("forces NODE_ENV=development so installs keep devDependencies", () => {
    process.env.NODE_ENV = "production";
    expect(previewEnv().NODE_ENV).toBe("development");
  });

  it("clears inherited npm production-omit signals", () => {
    process.env.npm_config_production = "true";
    process.env.npm_config_omit = "dev";
    const env = previewEnv();
    expect(env.npm_config_production).toBeUndefined();
    expect(env.npm_config_omit).toBeUndefined();
  });

  it("applies extra vars and preserves the rest of the env", () => {
    process.env.SOME_PREVIEW_MARKER = "keep";
    const env = previewEnv({ PORT: "1234" });
    expect(env.PORT).toBe("1234");
    expect(env.SOME_PREVIEW_MARKER).toBe("keep");
  });
});
