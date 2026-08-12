// ─── Live credential verify ────────────────────────────────────────────────
// Confirms a saved key actually authenticates — the missing half of "in-app
// key entry": today a key is stored and never tested (see routes.ts's header
// comment). One lightweight, read-only call per vendor; never a real
// generation. Never throws — a bad key, a network hiccup, or a vendor outage
// all come back as {ok:false, message} for the UI, and never blocks the save
// (a key can be valid but rate-limited at the instant it's checked).
//
// CLI-login vendors (cursor, copilot — see CLI_LOGIN_PROVIDERS in
// provider-env.ts) don't have a "list models" call gated by the pasted key the
// way the key-auth vendors do, so each is verified against the specific
// account/user REST endpoint its credential actually authenticates against
// (Cursor's account API for a Cursor key, GitHub's user API for a GitHub
// token) — the cheapest real signal available for that credential shape.
// `github` (a project-pinned PAT, not a fleet provider — see
// CredentialProvider) shares Copilot's path since both are GitHub tokens.

import type { CredentialProvider } from "@skynet/shared";

export interface VerifyCredentialResult {
  ok: boolean;
  message?: string;
}

const TIMEOUT_MS = 8_000;

/** Best-effort extraction of a vendor's own error message from a JSON body,
 *  so the UI shows "invalid x-api-key" rather than a generic "401". */
function firstErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return (err as Record<string, unknown>).message as string;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

async function checkEndpoint(url: string, headers: Record<string, string>, okMessage: string): Promise<VerifyCredentialResult> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, message: `Couldn't reach the verify endpoint: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true, message: okMessage };
  const body = await res.text().catch(() => "");
  return { ok: false, message: firstErrorMessage(body) ?? `${res.status} ${res.statusText}` };
}

const githubCheck = (apiKey: string) =>
  checkEndpoint(
    "https://api.github.com/user",
    { authorization: `Bearer ${apiKey}`, accept: "application/vnd.github+json" },
    "Token authenticates with GitHub.",
  );

const VERIFIERS: Record<CredentialProvider, (apiKey: string) => Promise<VerifyCredentialResult>> = {
  claude: (apiKey) =>
    checkEndpoint(
      "https://api.anthropic.com/v1/models",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      "Key authenticates with the Anthropic API.",
    ),
  codex: (apiKey) =>
    checkEndpoint("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` }, "Key authenticates with the OpenAI API."),
  gemini: (apiKey) =>
    checkEndpoint("https://generativelanguage.googleapis.com/v1beta/models", { "x-goog-api-key": apiKey }, "Key authenticates with the Gemini API."),
  hermes: (apiKey) =>
    checkEndpoint(
      "https://openrouter.ai/api/v1/auth/key",
      { authorization: `Bearer ${apiKey}` },
      "Key authenticates with OpenRouter (Hermes' recommended provider).",
    ),
  cursor: (apiKey) =>
    checkEndpoint("https://api.cursor.com/v0/me", { authorization: `Bearer ${apiKey}` }, "Key authenticates with the Cursor API."),
  copilot: githubCheck,
  github: githubCheck,
};

/** Live-verify a decrypted key against its vendor. Never throws. */
export async function verifyProviderCredential(provider: CredentialProvider, apiKey: string): Promise<VerifyCredentialResult> {
  return VERIFIERS[provider](apiKey);
}
