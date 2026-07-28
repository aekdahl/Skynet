/**
 * Conversational confirmation parsing, shared by both Steward surfaces (the in-app
 * project chat and Telegram) so "yes" / "accept all" mean the same thing in each.
 * Pure — no I/O, safe to import on the client.
 */

/** A parsed confirmation reply. `one` = confirm the single/next pending action;
 *  `all` = confirm every pending action at once ("accept all"); `no` = anything
 *  else (treated as not-a-confirmation / cancel). */
export type Confirmation = "one" | "all" | "no";

// "accept all" contains "accept" (a single-confirm word), so ALL is checked first.
const ALL = [
  "accept all",
  "yes to all",
  "yes all",
  "approve all",
  "confirm all",
  "do them all",
  "all of them",
  "all",
  "run all",
];
const YES = [
  "yes",
  "y",
  "ok",
  "okay",
  "yep",
  "yeah",
  "yup",
  "sure",
  "confirm",
  "do it",
  "go",
  "go ahead",
  "approve",
  "accept",
  "please do",
  "proceed",
];

export function parseConfirmation(text: string): Confirmation {
  const t = (text ?? "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (ALL.some((p) => t === p || t.startsWith(p + " "))) return "all";
  if (YES.includes(t)) return "one";
  return "no";
}
