import { useEffect, useState } from "react";
import {
  enableInboxAlerts,
  installState,
  notifyInbox,
  onInstallStateChange,
  promptInstall,
} from "../pwa/pwa";
import { alertsOn, setAlerts } from "../lib/alerts";

// Persistent "Install Skynet" + Inbox-alerts controls for the Settings page —
// always reachable, not just the one-shot first-run banner.
export function InstallControls() {
  const [state, setState] = useState(() => installState());
  const [note, setNote] = useState<string | null>(null);
  const [alerts, setAlertsState] = useState(() => alertsOn());

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

  // A real on/off. Turning on requests the OS permission; turning off mutes
  // notifications regardless of the (non-revocable) browser permission.
  const toggleAlerts = async () => {
    if (alerts) {
      setAlerts(false);
      setAlertsState(false);
      setNote("Inbox alerts off.");
      return;
    }
    const ok = await enableInboxAlerts();
    if (!ok) {
      setNote("Alerts are blocked — enable notifications in your browser.");
      return;
    }
    setAlerts(true);
    setAlertsState(true);
    setNote("Inbox alerts on — we'll ping you when an agent needs a decision.");
    void notifyInbox("Inbox alerts on", "We'll ping you when an agent needs a decision.");
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
      <button
        className={"btn " + (alerts ? "btn-lit" : "btn-ghost")}
        role="switch"
        aria-checked={alerts}
        onClick={toggleAlerts}
      >
        {alerts ? "✓ Inbox alerts on" : "Enable Inbox alerts"}
      </button>
      {note && (
        <span style={{ color: "var(--muted)", fontSize: 12, flexBasis: "100%" }}>{note}</span>
      )}
    </div>
  );
}
