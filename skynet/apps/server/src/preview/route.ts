// ─── Sandboxed preview route ──────────────────────────────────────────────
// Serves per-agent built artifacts under /preview/:agentId/* from an isolated
// root, with path-traversal protection and embedding-friendly security headers.
// Until a build step populates an agent's dir we serve a styled "building…"
// page, so the reserved preview URL is always live for the SPA to iframe.
//
// Sandboxing: content is confined to <artifactRoot>/<agentId>, never escapes
// via `..`, and is served with a `frame-ancestors` CSP. In production, serve
// previews from a SEPARATE origin (subdomain) so allow-same-origin iframes
// can't reach the control-plane origin; SKYNET_PREVIEW_BASE_URL points there.

import { createReadStream, existsSync, statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { previewConfig } from "./config.js";
import { previewService } from "./service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const mimeFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? MIME[path.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
};

function securityHeaders(reply: FastifyReply): void {
  // Allow embedding (the whole point) but pin the rest down.
  reply.header("Content-Security-Policy", `frame-ancestors ${previewConfig.frameAncestors}`);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cache-Control", "no-store");
}

/** Resolve a request path to a real file under <root>/<agentId>, or null if it escapes. */
function safeFile(agentId: string, rest: string): string | null {
  // Reject ids that could traverse; agent ids are slugs.
  if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) return null;
  const base = resolve(previewConfig.artifactRoot, agentId);
  const target = resolve(base, normalize(rest).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (target !== base && !target.startsWith(base + sep)) return null; // traversal guard
  return target;
}

function buildingPage(agentId: string): string {
  const safeId = agentId.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview building…</title><style>
:root{color-scheme:dark}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#0b0d12;color:#e7e9ee;
font:14px/1.5 ui-monospace,"IBM Plex Mono",Menlo,monospace}
.card{text-align:center;opacity:.92}
.spin{width:34px;height:34px;margin:0 auto 16px;border-radius:50%;
border:3px solid #2a2f3a;border-top-color:#f5a524;animation:s .9s linear infinite}
.id{color:#f5a524}
@keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="card">
<div class="spin"></div>
<div>Preview building for <span class="id">${safeId}</span></div>
<div style="opacity:.55;margin-top:6px">This sandboxed URL goes live as soon as the branch artifact is published.</div>
</div></body></html>`;
}

/**
 * Register the sandboxed preview route. No-op unless a non-`off` provider is
 * configured, so the default dev path mounts nothing.
 */
export async function registerPreview(app: FastifyInstance): Promise<boolean> {
  if (!previewService.enabled) return false;

  type PreviewParams = { agentId: string; "*"?: string };
  const handler = (req: FastifyRequest<{ Params: PreviewParams }>, reply: FastifyReply) => {
    const agentId = req.params.agentId ?? "";
    const rest = req.params["*"] ?? "";
    securityHeaders(reply);

    const target = safeFile(agentId, rest);
    if (!target) return reply.code(400).type("text/plain").send("bad request");

    // A concrete file under the artifact dir → serve it.
    if (rest && existsSync(target) && statSync(target).isFile()) {
      return reply.type(mimeFor(target)).send(createReadStream(target));
    }
    // The index ("/preview/:id/") → serve built index.html if present…
    const index = resolve(previewConfig.artifactRoot, agentId, "index.html");
    if (existsSync(index) && statSync(index).isFile()) {
      return reply.type("text/html; charset=utf-8").send(createReadStream(index));
    }
    // …otherwise the reserved-URL "building…" placeholder.
    return reply.type("text/html; charset=utf-8").send(buildingPage(agentId));
  };

  app.get<{ Params: PreviewParams }>("/preview/:agentId", handler);
  app.get<{ Params: PreviewParams }>("/preview/:agentId/", handler);
  app.get<{ Params: PreviewParams }>("/preview/:agentId/*", handler);
  app.log.info(`preview route mounted (mode=${previewService.mode}, root=${previewConfig.artifactRoot})`);
  return true;
}
