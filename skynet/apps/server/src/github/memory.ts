// ─── In-memory GitHub connection store ────────────────────────────────────
// Phase-0 persistence for the per-workspace connection (installation + repos +
// safety policy). The data is non-secret metadata; a Postgres/file adapter can
// drop in behind GithubConnectionStore the same way the secret store does.

import type { GithubConnection } from "@skynet/shared";
import type { GithubConnectionStore } from "./types.js";

export class MemoryGithubStore implements GithubConnectionStore {
  private byWorkspace = new Map<string, GithubConnection>();
  private tokens = new Map<string, string>(); // workspaceId → sealed ciphertext

  async get(workspaceId: string): Promise<GithubConnection | undefined> {
    return this.byWorkspace.get(workspaceId);
  }

  async put(connection: GithubConnection): Promise<void> {
    this.byWorkspace.set(connection.workspaceId, connection);
  }

  async delete(workspaceId: string): Promise<void> {
    this.byWorkspace.delete(workspaceId);
  }

  async getToken(workspaceId: string): Promise<string | undefined> {
    return this.tokens.get(workspaceId);
  }

  async putToken(workspaceId: string, ciphertext: string): Promise<void> {
    this.tokens.set(workspaceId, ciphertext);
  }

  async deleteToken(workspaceId: string): Promise<void> {
    this.tokens.delete(workspaceId);
  }
}
