// ─── Preview builder ──────────────────────────────────────────────────────
// Turns an agent's branch source into the served artifact — the piece that
// makes /preview real rather than a perpetual "building…" placeholder.
//
// Pipeline per agent (serialized, one build at a time):
//   resolve source → (optional install) → (optional build) → publish.
// Publish is an atomic swap: stage under the artifact root, then rename over
// the live dir so the SPA never iframes a half-written build. On any failure we
// publish a styled error page as index.html, so the reserved URL always serves
// something and the route needs no special-casing.
//
// Build commands run in THIS process's environment — a trust boundary, same as
// CI. The default (no SKYNET_PREVIEW_BUILD_CMD) only publishes static files, so
// nothing executes unless an operator opts in. Sandbox builds in prod.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { now } from "../config.js";
import { previewConfig } from "./config.js";
import { resolveSource } from "./source.js";

export type BuildStatus = "queued" | "building" | "ready" | "failed";

export interface BuildState {
  agentId: string;
  status: BuildStatus;
  updatedAt: number;
  log: string[];
  error?: string;
}

const LOG_TAIL = 200;

function runShell(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  onData: (chunk: string) => void,
): Promise<{ code: number }> {
  return new Promise((res) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env });
    const timer = setTimeout(() => {
      onData(`\n[timeout after ${timeoutMs}ms — killing build]\n`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => onData(d.toString()));
    child.stderr?.on("data", (d) => onData(d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      onData(`spawn error: ${err.message}\n`);
      res({ code: -1 });
    });
  });
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

function failurePage(agentId: string, error: string, log: string[]): string {
  const tail = log.slice(-14).map(esc).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview unavailable</title><style>
:root{color-scheme:dark}html,body{height:100%;margin:0}
body{background:#0b0d12;color:#e7e9ee;font:13px/1.55 ui-monospace,"IBM Plex Mono",Menlo,monospace;padding:28px;box-sizing:border-box}
h1{font-size:15px;margin:0 0 4px;color:#ff6b6b}
.sub{opacity:.6;margin-bottom:16px}.id{color:#f5a524}
pre{white-space:pre-wrap;background:#11141b;border:1px solid #232838;border-radius:8px;padding:12px;overflow:auto;max-height:60vh;opacity:.85}
</style></head><body>
<h1>Preview unavailable</h1>
<div class="sub">Build for <span class="id">${esc(agentId)}</span> did not produce a renderable artifact.</div>
<div>${esc(error)}</div>
${tail ? `<pre>${tail}</pre>` : ""}
</body></html>`;
}

export class PreviewBuilder {
  private states = new Map<string, BuildState>();
  private queue: Array<{ agentId: string; branch: string }> = [];
  private draining = false;

  stateOf(agentId: string): BuildState | undefined {
    return this.states.get(agentId);
  }

  /** Lazy/idempotent: build once. Skips if in-flight or already built. */
  request(agentId: string, branch: string): void {
    const s = this.states.get(agentId);
    if (s) return; // queued/building/ready/failed — don't re-trigger on every view
    this.enqueue(agentId, branch);
  }

  /** Force a fresh build regardless of prior state (e.g. branch advanced). */
  rebuild(agentId: string, branch: string): void {
    this.enqueue(agentId, branch);
  }

  private enqueue(agentId: string, branch: string): void {
    this.set(agentId, "queued");
    this.queue.push({ agentId, branch });
    void this.drain();
  }

  private set(agentId: string, status: BuildStatus, patch: Partial<BuildState> = {}): void {
    const prev = this.states.get(agentId);
    this.states.set(agentId, {
      agentId,
      status,
      updatedAt: now(),
      log: patch.log ?? prev?.log ?? [],
      error: patch.error ?? (status === "failed" ? prev?.error : undefined),
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      await this.run(job.agentId, job.branch).catch(() => {});
    }
    this.draining = false;
  }

  private async run(agentId: string, branch: string): Promise<void> {
    this.set(agentId, "building", { log: [] });
    const log: string[] = [];
    const append = (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) log.push(line);
      while (log.length > LOG_TAIL) log.shift();
      this.set(agentId, "building", { log: [...log] });
    };

    let src = null as Awaited<ReturnType<typeof resolveSource>>;
    try {
      src = await resolveSource(agentId, branch);
      if (!src) {
        await this.publishFailure(agentId, "No preview source configured for this branch.", log);
        return;
      }
      append(`source: ${src.kind} @ ${src.dir}`);

      if (previewConfig.installCmd) {
        const r = await runShell(previewConfig.installCmd, src.dir, previewConfig.buildTimeoutMs, append);
        if (r.code !== 0) return void (await this.publishFailure(agentId, `install failed (exit ${r.code})`, log));
      }

      let publishDir = src.dir;
      if (previewConfig.buildCmd) {
        const r = await runShell(previewConfig.buildCmd, src.dir, previewConfig.buildTimeoutMs, append);
        if (r.code !== 0) return void (await this.publishFailure(agentId, `build failed (exit ${r.code})`, log));
        publishDir = join(src.dir, previewConfig.outputDir);
      }

      if (!existsSync(join(publishDir, "index.html"))) {
        const where = previewConfig.buildCmd ? `output dir "${previewConfig.outputDir}"` : "source";
        return void (await this.publishFailure(agentId, `no index.html in ${where}`, log));
      }

      await this.publishDir(agentId, publishDir);
      this.set(agentId, "ready", { log });
      append(`published → ${agentId}/`);
    } catch (err) {
      await this.publishFailure(agentId, (err as Error).message, log);
    } finally {
      if (src) await src.cleanup().catch(() => {});
    }
  }

  // ── publish (atomic swap into <artifactRoot>/<agentId>) ────────────────────

  private async stagingDir(): Promise<string> {
    await mkdir(previewConfig.artifactRoot, { recursive: true });
    return mkdtempSync(join(previewConfig.artifactRoot, ".staging-"));
  }

  private async swap(agentId: string, staging: string): Promise<void> {
    const live = resolve(previewConfig.artifactRoot, agentId);
    await mkdir(dirname(live), { recursive: true });
    await rm(live, { recursive: true, force: true });
    await rename(staging, live); // same filesystem (both under artifactRoot)
  }

  private async publishDir(agentId: string, fromDir: string): Promise<void> {
    const staging = await this.stagingDir();
    await cp(fromDir, staging, { recursive: true });
    await this.swap(agentId, staging);
  }

  private async publishFailure(agentId: string, error: string, log: string[]): Promise<void> {
    const staging = await this.stagingDir();
    await writeFile(join(staging, "index.html"), failurePage(agentId, error, log), "utf8");
    await this.swap(agentId, staging);
    this.set(agentId, "failed", { log, error });
  }
}

/** Process-wide singleton. */
export const previewBuilder = new PreviewBuilder();
