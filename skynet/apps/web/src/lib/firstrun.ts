// First-run state. The monorepo has no workspace-create API (a workspace is the
// auth principal), so onboarding is "set up the existing workspace" — and the
// "have I done it" flag is a local, per-token marker. Keyed by the dev token so
// switching workspaces in dev gets its own first-run.

const tokenKey = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem("skynet_token")) || "dev-cyberdyne";

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(`skynet.onboarded.${tokenKey()}`) === "1";
  } catch {
    return false;
  }
}

export function setOnboarded(): void {
  try {
    localStorage.setItem(`skynet.onboarded.${tokenKey()}`, "1");
  } catch {
    /* ignore */
  }
}

export function operatorHandle(): string {
  try {
    return localStorage.getItem(`skynet.operator.${tokenKey()}`) || "";
  } catch {
    return "";
  }
}

export function setOperatorHandle(handle: string): void {
  try {
    localStorage.setItem(`skynet.operator.${tokenKey()}`, handle);
  } catch {
    /* ignore */
  }
}
