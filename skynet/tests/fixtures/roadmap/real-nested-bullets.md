  **Remaining:** the Fleet/Project UI ships (multi-select on Fleet, whole-project on the project page);
  optional "also remember" → area/workspace memory promotion is still v4, not started.
- [~] **🔗 Per-project live preview — "see what it builds", any software.** Today's W5 preview is
  per-agent-*branch* and effectively static/web. Generalize to a **stable per-project preview of the
  integration branch** that handles any software, not just SPAs. **Proposed approach:**
  - **A per-project preview descriptor** — `.skynet/preview.json` in the repo (auto-detected defaults
    from `package.json`/framework, operator-overridable in the project settings) declaring a `kind`
    plus `install`/`build`/`start`/`outputDir`/`port`/`healthPath`. Reuses the module-map pattern
    (repo-native config, per project).
  - **Three preview kinds, one seam:**
    · **static** (SPA/site) → build → serve `outputDir` (today's artifact mode, made per-project).
    · **service** (web app + server, API) → run `start` in the project's **sandboxed runner
    container** (v1) / opt-in OS sandbox (desktop), health-check the `port`, and expose it through a
    Skynet **reverse proxy** at a stable `preview.<project>.<host>` URL (desktop: a localhost port in
    an embedded webview). Streams build+runtime logs; auto-rebuilds on merge to the integration branch.
    The proxy rewrites the upstream `Host` to the loopback origin (`127.0.0.1:<port>`) — Vite 6+ dev
    servers reject a foreign `Host` with "Blocked request. This host is not allowed" (`server.allowedHosts`),
    so a public-origin proxy that forwards the real Host would break the preview; Host-rewrite fixes it
    for every framework without per-recipe flags. **Shipped:** a `/p/<token>/` reverse proxy fronts the
    loopback dev server on Skynet's learned public origin (Host-rewritten, HMR WebSocket bridged), Vite
    recipes get `--base=/p/<token>/`, and `PreviewState.url` becomes the proxied URL when hosted (loopback
    on desktop). *Bug fixed: base-injection matched the literal word "vite" against the OUTER command,
    but the common path resolves to `npm run dev` — the word never appears there, only inside the wrapped
    script — so injection silently never fired for the typical project and every preview fell into the
    regex-rewrite fallback (`preview-proxy.ts`'s `rewriteJsImports`), which can only re-prefix a path that
    appears as a quoted string literal — never a runtime-computed one (`import(variable)`, e.g.
    pdfjs-dist's fake-worker fallback), which is a structural blind spot no amount of regex tuning closes.
    `injectViteBase`/`npmRunScriptName` (`project-preview.ts`) now look through the `npm run` wrapper at
    the real script body, so base-mode — the actually-complete fix — applies to the common case too.*
    *Root-served (strip) mode made structurally correct — the pdf.worker reload-loop, ended: a
    `concurrently`-wrapped Vite (`"dev": "concurrently … \"npm:dev:client\""`, the Takeoff shape) puts the
    word "vite" two script-indirections deep, so base-injection can never fire and strip mode has to
    actually work. Three layers close it for good (all live-verified against a real
    Vite + pdfjs-dist + concurrently fixture through the real preview machinery): (1) `rewriteJsImports`
    also rewrites `export default "/…"` — the entire body Vite serves for a `?url` asset import, which is
    how a worker file's URL reaches app code as a runtime string (the exact pdfjs-dist leak the two
    earlier regex fixes missed); (2) SALVAGE — a token-less request in a dev-server-only namespace
    (`/@fs/…`, `/@vite/…`, `/@id/…`, `/node_modules/…`) that escaped the prefix is routed back to its
    preview (via the worktree path baked into `/@fs/` URLs → Referer → sole live preview) instead of
    falling through to the SPA fallback, catching the whole runtime-computed-URL class regex can never
    see; (3) the proxy now owns the server's `upgrade` event EXCLUSIVELY (delegating non-preview sockets
    to @fastify/websocket) and splices root-origin `vite-hmr`/`vite-ping` sockets through to the dev
    server — which both makes HMR genuinely work in strip mode and kills the once-per-second reload
    loop: @fastify/websocket completes a websocket handshake on any matched route before noticing there's
    no websocket handler, so Vite's "is the server back?" probe (success = the socket OPENS) always
    "succeeded" against the SPA fallback and the client reloaded forever; unroutable Vite sockets are now
    destroyed WITHOUT a handshake, so the probe fails honestly and the page just stays up.*
    Remaining Phase-2: the service-container runtime + auto-rebuild on merge.
    · **command** (CLI/lib/other) → run a command and surface **output/exit/artifacts** (no URL) —
    "preview" = run it and show the result. Covers "any software".
  - **Per project + per branch:** the project preview tracks the **integration branch** (what the fleet
    has merged); the existing per-run branch preview stays for reviewing a single agent's diff. One
    "Preview" affordance on the project view; the runtime kind decides URL vs. logs.
  - **Reuses** the existing preview builder, the **container/OS sandbox** (v0 #5 / v1), command-safety
    bounds, and the merge integration branch. Wrap, don't rebuild — Skynet orchestrates the build/run
    + proxy; it doesn't reimplement a PaaS.
  - **⭐ The overwatch loop + UX (the point of it):** the preview tracks the **integration branch** and
    **refreshes as the fleet merges** (dev-server HMR, or debounced rebuild + soft reload) so a human
    verifying agents watches the app change live. Opens **split-screen** beside the board or as a
    **pop-out modal**, with device-frame, a URL bar, freshness, logs, and manual restart/refresh. A
    per-run "Preview this change" button verifies a change *before* approving its merge.
    *(Shipped for web/sites: the split-screen dock ⇄ modal, refresh-on-merge, and the per-run
    "▶ Preview this change" button — the run's branch, pinned, pre-merge.)*
  - **Agent-assisted start:** the recipe resolves descriptor → heuristic → the **repo-aware assistant**
    (the same BYOK agent behind "Ask about this project" / Telegram) proposing + starting the preview.
  - Full design + phasing: **[docs/live-preview.md](docs/live-preview.md)**. **Phase-1 v0 (web/sites)
    shipped:** project + per-run preview managers (detached worktrees, opt-in sandbox, free-port +
    health-check), descriptor → heuristic → **agent-assisted** recipe resolution (proposal persisted to
    `.skynet/preview.json`), refresh-on-merge, node_modules provisioning (symlink the checkout's
    deps, else install) so a dev script's local bin resolves in the fresh worktree, and the
    **resizable** split-screen dock ⇄ modal (scrollable/resizable logs) with a "▶ Preview app"
