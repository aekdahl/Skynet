// ─── Telegram command parsing + security decision (PURE) ────────────────────
// No I/O, no side effects — every branch of the remote-control security model is
// decided here so it can be unit-tested exhaustively. index.ts only executes the
// action this returns; it never re-interprets the incoming text.

/** The slash-commands the bridge recognizes. Anything else is not a command. */
const KNOWN_COMMANDS = [
  "start",
  "help",
  "status",
  "inbox",
  "gates",
  "approve",
  "reject",
  "stop",
  "resume",
  "quit",
  "task",
  "newproject",
  "removetask",
] as const;

export type Command = (typeof KNOWN_COMMANDS)[number];

/**
 * Parse a single message into a recognized slash-command + optional argument.
 * Accepts a `@botname` suffix (Telegram appends it in groups) and a trailing arg
 * (e.g. a gate id): `/approve@my_bot q-123` → { cmd: "approve", arg: "q-123" }.
 * Returns null for anything that isn't a known slash-command — free text is NEVER
 * coerced into a command (no arbitrary-instruction execution).
 */
export function parseCommand(text: string): { cmd: Command; arg?: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // First whitespace-delimited token is the command; the remainder is the arg.
  const [head, ...rest] = trimmed.split(/\s+/);
  if (!head) return null;
  // Strip the leading slash and an optional @botname suffix.
  const name = head.slice(1).split("@")[0]?.toLowerCase() ?? "";
  if (!(KNOWN_COMMANDS as readonly string[]).includes(name)) return null;
  const arg = rest.join(" ").trim();
  return arg ? { cmd: name as Command, arg } : { cmd: name as Command };
}

/** The decision index.ts must execute. Contains the whole security decision. */
export type BridgeAction = {
  kind:
    | "help"
    | "status"
    // Read-only glanceable digest (decisions first) — like /status but richer.
    | "inbox"
    | "gates"
    | "approve"
    | "reject"
    | "stop"
    | "resume"
    | "quit"
    | "ignore"
    | "denied-approve"
    // Deterministic backlog add: `/task <text>` creates a task WITHOUT the LLM,
    // so backlogging works even with no consult-capable provider key. Gated by
    // the control flag (creating tasks is privileged) → "denied-control" when off.
    | "task"
    | "newproject"
    // Deterministic reversible archive: `/removetask <id>` archives a task by id
    // WITHOUT the LLM (the no-LLM undo path). Privileged → gated by the control
    // flag → "denied-control" when off.
    | "removetask"
    | "denied-control"
    // Owner free text (not a slash-command): index.ts routes it to the confirm
    // state machine (pending affirmative → run; else the conversational parse).
    // The deterministic commands above are ALWAYS decided here first, so the
    // kill switch + status never depend on the LLM.
    | "freetext";
  /** A trailing argument (e.g. a gate id for approve/reject), when present. */
  arg?: string;
};

export interface DecideInput {
  /** The chat the message came from. */
  chatId: string;
  /** The configured owner chat id — the ONLY chat we act on. */
  ownerChatId: string;
  /** Whether privileged control over chat is enabled (SKYNET_TELEGRAM_CONTROL).
   *  Gates the deterministic /approve|/reject AND the conversational actions. */
  controlEnabled: boolean;
  /** The raw message text. */
  text: string;
}

/**
 * The single deterministic security gate for the whole bridge:
 *  1. Owner-bound — a message from any chat other than the owner → "ignore"
 *     (index.ts logs it WITHOUT echoing content).
 *  2. Exact slash-commands are decided HERE, before any LLM parse — the kill
 *     switch (/stop, /quit), /status, /gates, /help never depend on the model.
 *  3. Control opt-in — /approve|/reject map to "denied-approve" when disabled.
 *  4. Any other owner text → "freetext" (routed to the confirm state machine).
 */
export function decide(input: DecideInput): BridgeAction {
  // 1. Owner-bound: never act on a message from a non-owner chat.
  if (String(input.chatId) !== String(input.ownerChatId)) return { kind: "ignore" };

  // 2. Only exact slash-commands are honored deterministically; other owner text
  //    is free text for the conversational path (NEVER executed as a command).
  const parsed = parseCommand(input.text);
  if (!parsed) return { kind: "freetext" };

  switch (parsed.cmd) {
    case "start":
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "inbox":
      return { kind: "inbox" };
    case "gates":
      return { kind: "gates" };
    case "stop":
      return { kind: "stop" };
    case "resume":
      return { kind: "resume" };
    case "quit":
      return { kind: "quit" };
    // 3. Approve/reject are gated behind the control flag.
    case "approve":
      return input.controlEnabled
        ? { kind: "approve", arg: parsed.arg }
        : { kind: "denied-approve" };
    case "reject":
      return input.controlEnabled
        ? { kind: "reject", arg: parsed.arg }
        : { kind: "denied-approve" };
    // Deterministic backlog add (no LLM). Privileged → gated by the control flag.
    case "task":
      return input.controlEnabled ? { kind: "task", arg: parsed.arg } : { kind: "denied-control" };
    // Deterministic project creation (no LLM). Privileged → gated by control.
    case "newproject":
      return input.controlEnabled ? { kind: "newproject", arg: parsed.arg } : { kind: "denied-control" };
    // Deterministic reversible archive by id (no LLM). Privileged → gated by control.
    case "removetask":
      return input.controlEnabled ? { kind: "removetask", arg: parsed.arg } : { kind: "denied-control" };
    default:
      return { kind: "help" };
  }
}
