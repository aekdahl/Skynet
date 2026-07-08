// ─── GitHub Device Flow (Phase 2) ───────────────────────────────────────────
// User-to-server auth for the desktop with NO client secret — only the public
// client_id. The user approves a short code in a browser; we poll for a token.
// That token proves identity to the broker (which mints installation tokens).
// https://docs.github.com/apps/creating-github-apps/authenticating/generating-a-user-access-token#device-flow

const GH = "https://github.com";

export interface DeviceCode {
  device_code: string;
  user_code: string; // shown to the user
  verification_uri: string; // where they enter it
  expires_in: number;
  interval: number; // min seconds between polls
}

/** Step 1: ask GitHub for a device + user code. */
export async function startDeviceFlow(clientId: string): Promise<DeviceCode> {
  const res = await fetch(`${GH}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "" }),
  });
  if (!res.ok) throw new Error(`device/code → ${res.status}`);
  return (await res.json()) as DeviceCode;
}

/** Step 2: poll once for the user token. Returns the token when authorized,
 *  null while still pending (caller waits `interval`s and retries). */
export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<string | null> {
  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.access_token) return data.access_token;
  // authorization_pending / slow_down → keep waiting; other errors → throw.
  if (data.error === "authorization_pending" || data.error === "slow_down") return null;
  throw new Error(`device token: ${data.error ?? "unknown error"}`);
}
