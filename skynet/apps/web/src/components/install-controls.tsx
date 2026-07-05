import { useEffect, useState } from "react";
import {
  enableInboxAlerts,
  installState,
  notifyInbox,
  onInstallStateChange,
  promptInstall,
} from "../pwa/pwa";

// Persistent "Install Skynet" + Inbox-alerts controls for the Settings page —
// always reachable, not just the one-shot first-run banner.
export function InstallControls() {
  const [state, setState] = useState(() => installState());
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => onInstallStateChange(() => setState(installState())), []);

  const onInstall = async () => {
    const r = await promptInstall();
    if (r === "unavailable") {
      setNote("No prompt available here — use your browser's Install / “Add to Home Screen”.");
    } else if (r === "accepted") {
      setNote("Installing…");
    } else {
      setNote(null);
    }
  };

  const onAlerts = async () => {
    const ok = await enableInboxAlerts();
    setNote(ok ? "Inbox alerts enabled." : "Alerts are blocked — enable notifications in your browser.");
    if (ok) void notifyInbox("Inbox alerts on", "We'll ping you when an agent needs a decision.");
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {state.installed ? (
        <button className="btn btn-ghost" disabled>
          ✓ Skynet installed
        </button>
      ) : (
        <button className="btn btn-primary" onClick={onInstall}>
          ⤓ Install Skynet
        </button>
      )}
      <button className="btn btn-ghost" onClick={onAlerts}>
        Enable Inbox alerts
      </button>
      {note && (
        <span style={{ color: "var(--faint)", fontSize: 12, flexBasis: "100%" }}>{note}</span>
      )}
    </div>
  );
}
