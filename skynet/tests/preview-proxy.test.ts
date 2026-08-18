// The live-preview reverse proxy makes a loopback dev server reachable at
// /p/<token>/ on Skynet's public origin — and, crucially, forwards with the Host
// rewritten to loopback so Vite's allowedHosts accepts it. These pin the pure
// bits: token extraction from the path, and public-origin learning (env wins;
// loopback ignored).
import { describe, it, expect, beforeEach } from "vitest";
import {
  previewTokenOf,
  stripPreviewPrefix,
  rewritePreviewHtml,
  rewriteJsImports,
  isDevServerPath,
  salvagePreviewToken,
  isViteClientSocket,
} from "../apps/server/src/preview/preview-proxy.js";
import { recordPublicOrigin, publicOrigin, __resetPublicOrigin } from "../apps/server/src/preview/public-origin.js";

describe("previewTokenOf", () => {
  it("extracts the token from a /p/<token>/… path", () => {
    expect(previewTokenOf("/p/abc123/")).toBe("abc123");
    expect(previewTokenOf("/p/abc123/@vite/client")).toBe("abc123");
    expect(previewTokenOf("/p/abc-_.9/index.html?x=1")).toBe("abc-_.9");
    expect(previewTokenOf("/p/tok")).toBe("tok");
  });
  it("returns null for non-preview paths", () => {
    expect(previewTokenOf("/api/snapshot")).toBeNull();
    expect(previewTokenOf("/p/")).toBeNull();
    expect(previewTokenOf("/")).toBeNull();
  });
});

describe("stripPreviewPrefix", () => {
  it("drops the /p/<token> prefix, keeping a leading slash", () => {
    expect(stripPreviewPrefix("/p/abc/main.jsx", "abc")).toBe("/main.jsx");
    expect(stripPreviewPrefix("/p/abc/@vite/client", "abc")).toBe("/@vite/client");
    expect(stripPreviewPrefix("/p/abc/src/App.tsx?t=1", "abc")).toBe("/src/App.tsx?t=1");
  });
  it("maps the bare prefix (with or without trailing slash) to /", () => {
    expect(stripPreviewPrefix("/p/abc", "abc")).toBe("/");
    expect(stripPreviewPrefix("/p/abc/", "abc")).toBe("/");
  });
  it("keeps a query on the bare prefix", () => {
    expect(stripPreviewPrefix("/p/abc?x=1", "abc")).toBe("/?x=1");
  });
  it("leaves an unrelated path untouched", () => {
    expect(stripPreviewPrefix("/other", "abc")).toBe("/other");
  });
});

describe("rewritePreviewHtml", () => {
  const P = "/p/abc123";
  it("re-prefixes root-absolute src/href attributes", () => {
    const html = `<link rel="stylesheet" href="/style.css"><script type="module" src="/main.jsx"></script>`;
    const out = rewritePreviewHtml(html, P);
    expect(out).toContain(`href="/p/abc123/style.css"`);
    expect(out).toContain(`src="/p/abc123/main.jsx"`);
  });
  it("re-prefixes absolute module imports inside inline scripts (react-refresh preamble)", () => {
    const html = `<script type="module">\nimport RefreshRuntime from "/@react-refresh"\nimport("/lazy.js")\n</script>`;
    const out = rewritePreviewHtml(html, P);
    expect(out).toContain(`from "/p/abc123/@react-refresh"`);
    expect(out).toContain(`import("/p/abc123/lazy.js"`);
  });
  it("leaves protocol-relative, absolute-URL, and already-prefixed values alone", () => {
    const html = `<script src="//cdn.example.com/x.js"></script><img src="https://ex.com/a.png"><script src="/p/abc123/already.js"></script>`;
    expect(rewritePreviewHtml(html, P)).toBe(html);
  });
  it("does not touch relative paths", () => {
    const html = `<script src="./rel.js"></script><img src="rel.png">`;
    expect(rewritePreviewHtml(html, P)).toBe(html);
  });
});

describe("rewriteJsImports", () => {
  const P = "/p/abc123";
  it("re-prefixes root-absolute static import/re-export specifiers", () => {
    const js = `import App from "/src/App.jsx"\nexport { x } from "/src/x.js"`;
    const out = rewriteJsImports(js, P);
    expect(out).toContain(`from "/p/abc123/src/App.jsx"`);
    expect(out).toContain(`from "/p/abc123/src/x.js"`);
  });
  it("re-prefixes root-absolute side-effect and dynamic imports", () => {
    const js = `import "/src/styles.css"\nconst m = import("/src/lazy.js")`;
    const out = rewriteJsImports(js, P);
    expect(out).toContain(`import "/p/abc123/src/styles.css"`);
    expect(out).toContain(`import("/p/abc123/src/lazy.js"`);
  });
  it("re-prefixes /@fs/ absolute filesystem imports (Vite deps cache)", () => {
    const js = `import React from "/@fs/data/worktrees/preview/node_modules/.vite/deps/react.js"`;
    expect(rewriteJsImports(js, P)).toContain(`from "/p/abc123/@fs/data/worktrees/preview/node_modules/.vite/deps/react.js"`);
  });
  it("leaves relative, absolute-URL, and already-prefixed specifiers alone", () => {
    const js = `import "./rel.js"\nimport "http://cdn.example.com/x.js"\nimport "/p/abc123/already.js"`;
    expect(rewriteJsImports(js, P)).toBe(js);
  });
  it("re-prefixes new URL(\"/…\", import.meta.url) — Vite's transform for a worker/asset URL (e.g. pdfjs-dist's pdf.worker)", () => {
    const js = `const w = new URL("/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`;
    expect(rewriteJsImports(js, P)).toBe(
      `const w = new URL("/p/abc123/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`,
    );
  });
  it("re-prefixes new URL(…) even with Vite's injected /* @vite-ignore */ comment before the literal", () => {
    const js = `const w = new URL(/* @vite-ignore */ "/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`;
    expect(rewriteJsImports(js, P)).toBe(
      `const w = new URL(/* @vite-ignore */ "/p/abc123/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`,
    );
  });
  it("re-prefixes a dynamic import(…) even with a /* @vite-ignore */ comment before the literal", () => {
    const js = `await import(/* @vite-ignore */ "/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs")`;
    expect(rewriteJsImports(js, P)).toBe(
      `await import(/* @vite-ignore */ "/p/abc123/@fs/data/worktrees/preview/node_modules/pdfjs-dist/build/pdf.worker.min.mjs")`,
    );
  });
  it("re-prefixes export default \"/…\" — Vite's dev response for a `?url` asset import (THE pdfjs-dist worker leak)", () => {
    // vite:asset load() serves `import x from "…?url"` as exactly this module:
    // a bare exported string. The string is consumed at RUNTIME (new Worker(x) /
    // import(x)) where no rewriter can see it — so it must be prefixed here.
    const js = `export default "/@fs/data/worktrees/preview-p-1/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?import"`;
    expect(rewriteJsImports(js, P)).toBe(
      `export default "/p/abc123/@fs/data/worktrees/preview-p-1/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?import"`,
    );
  });
  it("leaves export default alone when already prefixed, relative, or not a string path", () => {
    const already = `export default "/p/abc123/x.js"`;
    expect(rewriteJsImports(already, P)).toBe(already);
    const object = `export default { url: 1 }`;
    expect(rewriteJsImports(object, P)).toBe(object);
    const protoRel = `export default "//cdn.example.com/x.js"`;
    expect(rewriteJsImports(protoRel, P)).toBe(protoRel);
  });
});

describe("isDevServerPath", () => {
  it("recognizes the namespaces only a dev server owns", () => {
    for (const p of ["/@fs/data/x/y.js", "/@vite/client", "/@id/some-id", "/@react-refresh", "/node_modules/.vite/deps/react.js", "/__vite_ping"]) {
      expect(isDevServerPath(p), p).toBe(true);
    }
  });
  it("ignores query strings when classifying", () => {
    expect(isDevServerPath("/@fs/data/w/pdf.worker.min.mjs?import")).toBe(true);
  });
  it("rejects ordinary app/Skynet paths", () => {
    for (const p of ["/", "/api/snapshot", "/p/tok/@vite/client", "/assets/index.js", "/src/App.tsx"]) {
      expect(isDevServerPath(p), p).toBe(false);
    }
  });
});

describe("salvagePreviewToken", () => {
  const A = { token: "tokA", dir: "/data/worktrees/preview-p-a-1", stripPrefix: true };
  const B = { token: "tokB", dir: "/data/worktrees/preview-p-b-1", stripPrefix: true };

  it("resolves by the worktree dir embedded in an /@fs/ path (works with no Referer — e.g. a worker's own sub-requests)", () => {
    const url = "/@fs/data/worktrees/preview-p-b-1/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?import";
    expect(salvagePreviewToken(url, undefined, [A, B])).toBe("tokB");
  });
  it("decodes percent-encoded /@fs/ paths before matching", () => {
    const url = "/@fs/data/worktrees/preview-p-a-1/node_modules/some%20pkg/x.js";
    expect(salvagePreviewToken(url, undefined, [A, B])).toBe("tokA");
  });
  it("falls back to the Referer's /p/<token>/ page", () => {
    const url = "/@vite/client";
    expect(salvagePreviewToken(url, "https://skynet.example.com/p/tokB/", [A, B])).toBe("tokB");
  });
  it("ignores a Referer token that is not a live candidate", () => {
    expect(salvagePreviewToken("/@vite/client", "https://x.example.com/p/gone/", [A, B])).toBeNull();
  });
  it("falls back to the sole live preview", () => {
    expect(salvagePreviewToken("/@vite/client", undefined, [A])).toBe("tokA");
  });
  it("returns null when ambiguous, when no previews are live, or for a non-dev path", () => {
    expect(salvagePreviewToken("/@vite/client", undefined, [A, B])).toBeNull();
    expect(salvagePreviewToken("/@vite/client", undefined, [])).toBeNull();
    expect(salvagePreviewToken("/api/snapshot", undefined, [A])).toBeNull();
  });
});

describe("isViteClientSocket", () => {
  it("matches vite-hmr and vite-ping subprotocols", () => {
    expect(isViteClientSocket("vite-hmr")).toBe(true);
    expect(isViteClientSocket("vite-ping")).toBe(true);
    expect(isViteClientSocket(["vite-hmr"])).toBe(true);
  });
  it("rejects other/absent protocols", () => {
    expect(isViteClientSocket(undefined)).toBe(false);
    expect(isViteClientSocket("graphql-ws")).toBe(false);
    expect(isViteClientSocket("vite-hmrx")).toBe(false);
  });
});

describe("public origin learning", () => {
  beforeEach(() => {
    delete process.env.SKYNET_PUBLIC_URL;
    delete process.env.SKYNET_PREVIEW_BASE_URL;
    __resetPublicOrigin();
  });

  it("learns from forwarded proto+host, ignoring loopback", () => {
    recordPublicOrigin("https", "skynet.example.com");
    expect(publicOrigin()).toBe("https://skynet.example.com");
  });

  it("ignores loopback/local hosts (desktop stays loopback-only)", () => {
    recordPublicOrigin("http", "localhost:8080");
    recordPublicOrigin("http", "127.0.0.1:8080");
    expect(publicOrigin()).toBeUndefined();
  });

  it("takes the first value from a comma-joined forwarded header", () => {
    recordPublicOrigin("https,http", "skynet.example.com, internal", undefined);
    expect(publicOrigin()).toBe("https://skynet.example.com");
  });

  it("an explicit env origin wins over the learned one", () => {
    recordPublicOrigin("https", "learned.example.com");
    process.env.SKYNET_PUBLIC_URL = "https://pinned.example.com/";
    expect(publicOrigin()).toBe("https://pinned.example.com"); // trailing slash trimmed
  });

  it("falls back to Host when no forwarded host is present", () => {
    recordPublicOrigin(undefined, undefined, "app.example.com");
    expect(publicOrigin()).toBe("https://app.example.com"); // defaults to https
  });
});
