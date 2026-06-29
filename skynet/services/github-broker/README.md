# Skynet GitHub token broker (GCP gen-2 function)

Phase 2 of GitHub auth. A **stateless** HTTPS function that mints short-lived
GitHub App **installation tokens** for authorized users — so the App private key
never ships in the desktop app. See `[[github-integration-plan]]`.

```
desktop ──Device Flow (client_id only)──▶ GitHub        (user token, local)
desktop ──POST /token {userToken, installationId}──▶ broker
broker  ──verify GET /user/installations, then mint with App key──▶ GitHub
broker  ──{ token, expiresAt }──▶ desktop ──git push/PR──▶ GitHub   (direct)
```

It holds **only** the App private key (Secret Manager). No database: GitHub is
the source of truth for "can this user access this installation".

## One-time setup
1. Register a **GitHub App** (Settings → Developer settings → GitHub Apps):
   - Permissions: **Contents: read/write**, **Pull requests: read/write**, **Checks: read**, **Metadata: read**.
   - Enable **Device Flow**.
   - Note the **App ID** and generate a **private key** (.pem); note the public **client_id** (the desktop uses it for device flow).
2. Store secrets:
   ```bash
   gcloud secrets create github-app-id --replication-policy=automatic
   printf '%s' "<APP_ID>" | gcloud secrets versions add github-app-id --data-file=-
   gcloud secrets create github-app-private-key --replication-policy=automatic
   gcloud secrets versions add github-app-private-key --data-file=app-private-key.pem
   ```
3. Deploy (the function's runtime SA needs `roles/secretmanager.secretAccessor`):
   ```bash
   REGION=europe-west1 pnpm deploy
   ```
   `--no-allow-unauthenticated` is set — front it with auth/your gateway, or relax for testing.

## Contract
`POST /token` → `{ userToken: string, installationId: number }` → `200 { token, expiresAt }`.
- `400` missing fields · `403` the user can't access that installation · `502` mint failed.

## Local run
```bash
GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" pnpm start
```

## Notes
- **Webhooks** (PR/check status) are intentionally out of v1 — the desktop polls
  GitHub directly with the minted token. Add a `/webhook` route (+ Pub/Sub or
  Firestore to fan out to desktops) later if you want push.
- Tokens are ~1h; the desktop caches until just before expiry and re-mints.
- This service is **excluded from the pnpm workspace** — it deploys standalone.
