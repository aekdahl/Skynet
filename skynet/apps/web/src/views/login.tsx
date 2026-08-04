import { useState } from "react";
import { TitleBar } from "../components/shell";
import type { LoginResult } from "../lib/client";

// Sign-in for the public deploy (dev tokens are disabled in production). Two
// phases: email + password, then — if MFA is on — a one-time code sent to the
// owner's Telegram (or a recovery code). On success the token is stored and the
// app reconnects. Shown whenever the socket reports it's unauthorized, so a
// wiped/expired session lands here instead of a dead end.
export function LoginView({
  onLogin,
  onVerifyMfa,
}: {
  onLogin: (email: string, password: string) => Promise<LoginResult>;
  onVerifyMfa: (challengeId: string, code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await onLogin(email.trim(), password);
      if (result.mfaRequired) {
        setChallengeId(result.challengeId); // → show the code step
        setBusy(false);
      }
      // else: onLogin reloaded the app; keep busy until it does.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !challengeId) return;
    setError(null);
    setBusy(true);
    try {
      await onVerifyMfa(challengeId, code.trim());
      // onVerifyMfa reloads on success — keep busy until it does.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="app">
      <TitleBar />
      <div className="op-shell">
        <main className="main">
          <div className="content">{children}</div>
        </main>
      </div>
    </div>
  );

  if (challengeId) {
    return shell(
      <form className="connect-state" onSubmit={submitCode}>
        <span className="op-ws-logo">S</span>
        <p className="connect-status">Enter your login code</p>
        <p className="connect-sub">
          We sent a one-time code to your Telegram. It expires in 5 minutes — or use a recovery code.
        </p>
        <input
          className="qx-input"
          type="text"
          inputMode="numeric"
          autoFocus
          autoComplete="one-time-code"
          placeholder="6-digit code (or recovery code)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        {error && (
          <p className="connect-sub" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setChallengeId(null);
            setCode("");
            setError(null);
          }}
        >
          ← Back
        </button>
      </form>,
    );
  }

  return shell(
    <form className="connect-state" onSubmit={submitPassword}>
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
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>,
  );
}
