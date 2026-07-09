// Side-effect module: force AUTH_REQUIRED on *before* config.ts is imported.
//
// config.ts snapshots process.env at import time. ES modules are evaluated
// depth-first in source order, so importing THIS module before ../src/ws.js
// (which pulls in auth.js → config.js) guarantees the flag is set first. A
// plain top-of-file `process.env.X = ...` in the spec would run too late —
// import statements are hoisted and evaluated before that assignment.
//
// Why force it on: the WS handler rejects a connection only when authenticate()
// returns undefined. In the dev/test env AUTH_REQUIRED defaults OFF, so an
// absent/unknown token falls back to an open default principal and DOES get a
// snapshot — the rejection cases would never fire. With the guard on, dev tokens
// still resolve (they bypass the guard, dev-only), so the accept cases hold too.
process.env.AUTH_REQUIRED = "true";
