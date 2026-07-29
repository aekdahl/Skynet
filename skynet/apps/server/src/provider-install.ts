// ─── Provider CLI installer ─────────────────────────────────────────────────
// Spawns the fixed install command for a provider (see provider-requirements.ts)
// and streams stdout+stderr line-by-line so the Settings UI can show live
// output. Never accepts a caller-supplied command — the argv comes from the
// server's own INSTALL_COMMAND table, chosen by provider id. Only providers
// whose install is scriptable (npm) are supported today; brew / sign-in / manual
// installs return null from installCommandFor and are refused here.
//
// The command is spawned with execFile-style argv (not `shell: true`), so
// there is no shell interpolation of the argv or environment. Cross-platform:
// on Windows npm.exe → npm.cmd, so we spawn via shell=false + resolvable name
// (the `.cmd` shim is on PATH on Windows npm installs). The active process
// PATH is inherited unchanged.

import { spawn } from "node:child_process";
import type { ProviderId } from "@skynet/shared";
import { installCommandFor, probeBinOnPath, providerBin } from "./provider-requirements.js";

/** A single line of installer output — plain telemetry, no ANSI stripping (npm
 *  is quiet enough that raw output is fine). Kind lets a viewer color stderr. */
export interface InstallEvent {
  kind: "line" | "done" | "error";
  /** Present on "line" and "error". */
  text?: string;
  /** Exit code on "done"; null when the process failed to spawn. */
  exitCode?: number | null;
  /** Present on "done": whether the CLI is now resolvable on PATH. */
  binOnPath?: boolean;
}

/**
 * Kick off the provider's install and stream events until the process exits (or
 * fails to spawn). One-shot per call — the caller drains the async iterable.
 * The final `done` event carries the exit code AND a re-probe of the CLI's
 * PATH resolution so the operator sees whether the install actually succeeded.
 */
export async function* installProviderCli(id: ProviderId): AsyncGenerator<InstallEvent> {
  const install = installCommandFor(id);
  if (!install) {
    yield { kind: "error", text: `No auto-install available for provider "${id}". See the docs link on the provider card.` };
    return;
  }
  // Parse the fixed command string into argv. Since these are hand-authored in
  // provider-requirements.ts with plain args (no quoting / shell tricks), a
  // split on whitespace is safe here. If a future entry needs shell semantics,
  // stop and revisit — don't relax this parse.
  const parts = install.command.split(/\s+/).filter(Boolean);
  const [bin, ...args] = parts;
  if (!bin) {
    yield { kind: "error", text: `Malformed install command for "${id}".` };
    return;
  }

  yield { kind: "line", text: `$ ${install.command}` };

  let child;
  try {
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  } catch (err) {
    // ENOENT — the package manager itself isn't installed. Say so cleanly.
    yield {
      kind: "error",
      text: `Couldn't spawn "${bin}" — is it installed and on the server's PATH? (${(err as Error).message})`,
    };
    yield { kind: "done", exitCode: null, binOnPath: false };
    return;
  }

  // A small buffered iterator that reads stdout+stderr line-by-line as they
  // arrive, without missing a partial trailing chunk. Yielding here relays the
  // lines out of the generator to the streaming route.
  const queue: InstallEvent[] = [];
  let resolveNext: (() => void) | null = null;
  const push = (ev: InstallEvent) => {
    queue.push(ev);
    const r = resolveNext;
    resolveNext = null;
    if (r) r();
  };
  const lineReader = (stream: NodeJS.ReadableStream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        push({ kind: "line", text: buf.slice(0, nl) });
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buf.length) push({ kind: "line", text: buf });
    });
  };
  lineReader(child.stdout!);
  lineReader(child.stderr!);

  const exit = new Promise<number | null>((resolve) => {
    child!.on("close", (code) => resolve(code));
    child!.on("error", () => resolve(null));
  });

  // Drain events + wait for exit interleaved. We loop until exit resolves AND
  // the queue is empty (both streams have finished flushing).
  let hasExited = false;
  let exitCode: number | null = null;
  void exit.then((code) => {
    hasExited = true;
    exitCode = code;
    const r = resolveNext;
    resolveNext = null;
    if (r) r();
  });
  for (;;) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (hasExited) break;
    await new Promise<void>((r) => (resolveNext = r));
  }

  const binName = providerBin(id);
  const onPath = binName ? probeBinOnPath(binName) : false;
  yield { kind: "done", exitCode, binOnPath: onPath };
}
