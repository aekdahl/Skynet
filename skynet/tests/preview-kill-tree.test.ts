// A live preview runs a process TREE (sh → concurrently → node + vite). Killing
// only the shell we spawned orphans the dev servers, which keep holding their
// ports — the next start then dies with EADDRINUSE and the preview shows a blank
// page. killTree must reap the WHOLE group. This spawns a real detached tree
// whose grandchild binds a port and asserts the port frees on killTree.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { killTree } from "../apps/server/src/preview/project-preview.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => (p ? res(p) : rej(new Error("no port"))));
    });
  });

const portInUse = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const sock = connect({ host: "127.0.0.1", port, timeout: 500 }, () => {
      sock.destroy();
      res(true);
    });
    sock.on("error", () => res(false));
    sock.on("timeout", () => {
      sock.destroy();
      res(false);
    });
  });

async function waitFor(pred: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("killTree — reaps the whole dev-server process group", () => {
  // POSIX process-group semantics (detached + negative-pid signal); Windows differs.
  it.skipIf(process.platform === "win32")(
    "a grandchild holding a port dies when the group is killed (not just the shell)",
    async () => {
      const port = await freePort();
      // sh (the detached group leader) forks a node grandchild that binds `port`
      // and stays up — mirroring `sh -c "npm run dev"` → concurrently → node.
      // Killing only sh.pid would orphan node; killTree signals the GROUP.
      const script = `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1e9)`;
      const child = spawn("sh", ["-c", `node -e "${script}" & wait`], { detached: true, stdio: "ignore" });

      expect(await waitFor(() => portInUse(port))).toBe(true); // grandchild bound the port

      killTree(child);

      // The port frees — proving the node GRANDCHILD was killed, not just sh
      // (an orphaned node would keep the port → next preview EADDRINUSE).
      expect(await waitFor(() => portInUse(port).then((v) => !v))).toBe(true);
    },
    20000,
  );

  it("is a no-op for an absent/already-killed child (no throw)", () => {
    expect(() => killTree(undefined)).not.toThrow();
  });
});
