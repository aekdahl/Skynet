import { useState } from "react";
import { TitleBar } from "../components/shell";

// The web client authenticates with a session token (see client.ts). In a
// production deploy dev tokens are disabled, so the operator signs in here with
// the seeded admin email + password (SKYNET_ADMIN_*). On success the token is
// stored and the app reconnects — shown whenever the socket reports it's
// unauthorized, so a wiped/expired session lands here instead of a dead end.
export function LoginView({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onLogin(email.trim(), password);
      // onLogin reloads the app on success — keep the button busy until then.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <TitleBar />
      <div className="op-shell">
        <main className="main">
          <div className="content">
            <form className="connect-state" onSubmit={submit}>
              <span className="op-ws-logo">S</span>
              <p className="connect-status">Sign in to mission control</p>
              <p className="connect-sub">Use your operator email and admin password.</p>
              <input
                className="qx-input"
                type="email"
                autoFocus
                autoComplete="username"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ maxWidth: 320 }}
              />
              <input
                className="qx-input"
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ maxWidth: 320 }}
              />
              {error && (
                <p className="connect-sub" role="alert" style={{ color: "var(--danger)" }}>
                  {error}
                </p>
              )}
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !email.trim() || !password}
              >
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
