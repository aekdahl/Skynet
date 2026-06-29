// ─── GitHub token-broker client (Phase 2) ──────────────────────────────────
// Talks to the GCP gen-2 broker function (services/github-broker) to mint a
// short-lived installation token from a user token + installation id. Used when
// the desktop has no local App key (the App private key lives only on the cloud).

/** Exchange a user-to-server token for an installation token via the broker. */
export async function mintViaBroker(
  brokerUrl: string,
  userToken: string,
  installationId: number,
): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch(brokerUrl.replace(/\/$/, "") + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userToken, installationId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`broker /token → ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as { token: string; expiresAt: string };
}
