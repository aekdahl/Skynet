// App-level Inbox-alerts preference. Browser notification permission can't be
// revoked from JS, so THIS flag is the real on/off switch: notifyInbox() no-ops
// when it's off, regardless of the OS-level permission. Off by default. Keyed
// per token (workspace proxy) so each workspace has its own setting.

const key = () =>
  `skynet.alerts.${(typeof localStorage !== "undefined" && localStorage.getItem("skynet_token")) || "dev-cyberdyne"}`;

export function alertsOn(): boolean {
  try {
    return localStorage.getItem(key()) === "1";
  } catch {
    return false;
  }
}

export function setAlerts(on: boolean): void {
  try {
    localStorage.setItem(key(), on ? "1" : "0");
  } catch {
    /* ignore */
  }
}
