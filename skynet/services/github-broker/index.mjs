// ─── Skynet GitHub token broker (GCP Cloud Function gen 2) ──────────────────
// A small, STATELESS HTTPS function. It holds the Skynet GitHub App's private
// key (from Secret Manager) and does one thing: exchange a caller's GitHub
// user-to-server token + an installation id for a short-lived INSTALLATION
// token — but only if that user actually has access to the installation.
//
// Why a broker: the App private key must never ship in the desktop app. The
// desktop authenticates the user locally via GitHub Device Flow (client_id
// only, no secret), then calls this function to mint least-privilege tokens.
// Git traffic stays desktop→GitHub; this is only in the mint path. No DB:
// GitHub is the source of truth for "can this user access this installation".
//
// Deploy: see README.md. Env (via Secret Manager): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY.

import { http } from "@google-cloud/functions-framework";
import { createSign } from "node:crypto";

const API = process.env.GITHUB_API_URL || "https://api.github.com";

const b64url = (s) => Buffer.from(s).toString("base64url");

/** Signed App JWT (10-min lifetime, 60s back-dated for clock skew). */
function appJwt() {
  const appId = process.env.GITHUB_APP_ID;
  const key = (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!appId || !key) throw new Error("broker misconfigured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset");
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}`);
  return res.json();
}

/** True iff `userToken` can access `installationId` (the authorization gate). */
async function userOwnsInstallation(userToken, installationId) {
  const data = await gh(userToken, "GET", "/user/installations?per_page=100");
  return (data.installations || []).some((i) => Number(i.id) === Number(installationId));
}

http("token", async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const userToken = req.body?.userToken;
  const installationId = req.body?.installationId;
  if (!userToken || !installationId) return res.status(400).json({ error: "userToken and installationId are required" });

  try {
    // Authorization: never mint for an installation the caller can't access.
    if (!(await userOwnsInstallation(userToken, installationId))) {
      return res.status(403).json({ error: "token has no access to that installation" });
    }
    const minted = await gh(appJwt(), "POST", `/app/installations/${installationId}/access_tokens`);
    return res.status(200).json({ token: minted.token, expiresAt: minted.expires_at });
  } catch (err) {
    // Don't leak internals; the desktop just needs to know it failed.
    return res.status(502).json({ error: "could not mint an installation token" });
  }
});
