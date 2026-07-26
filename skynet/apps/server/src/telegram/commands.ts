// ─── Telegram command parsing + security decision (PURE) ────────────────────
// No I/O, no side effects — every branch of the remote-control security model is
// decided here so it can be unit-tested exhaustively. index.ts only executes the
// action this returns; it never re-interprets the incoming text.

/** The slash-commands the bridge recognizes. Anything else is not a command. */
const KNOWN_COMMANDS = [
  "start",
  "help",
  "status",
  "gates",
  "approve",
  "reject",
  "stop",
  "resume",
  "quit",
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
    | "gates"
    | "approve"
    | "reject"
    | "stop"
    | "resume"
    | "quit"
    | "ignore"
    | "denied-approve";
  /** A trailing argument (e.g. a gate id for approve/reject), when present. */
  arg?: string;
};

export interface DecideInput {
  /** The chat the message came from. */
  chatId: string;
  /** The configured owner chat id — the ONLY chat we act on. */
  ownerChatId: string;
  /** Whether approve/reject over chat is enabled (SKYNET_TELEGRAM_APPROVE). */
  approveEnabled: boolean;
  /** The raw message text. */
  text: string;
}

/**
 * The single security gate for the whole bridge:
 *  1. Owner-bound — a message from any chat other than the owner → "ignore"
 *     (index.ts logs it WITHOUT echoing content).
 *  2. No free-text execution — anything that isn't an exact slash-command → "help".
 *  3. Approve opt-in — /approve|/reject map to "denied-approve" when disabled; the
 *     kill switch (/stop, /quit) and /status|/gates always work.
 */
export function decide(input: DecideInput): BridgeAction {
  // 1. Owner-bound: never act on a message from a non-owner chat.
  if (String(input.chatId) !== String(input.ownerChatId)) return { kind: "ignore" };

  // 2. Only exact slash-commands are honored; everything else → /help.
  const parsed = parseCommand(input.text);
  if (!parsed) return { kind: "help" };

  switch (parsed.cmd) {
    case "start":
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "gates":
      return { kind: "gates" };
    case "stop":
      return { kind: "stop" };
    case "resume":
      return { kind: "resume" };
    case "quit":
      return { kind: "quit" };
    // 3. Approve/reject are gated behind the opt-in flag.
    case "approve":
      return input.approveEnabled
        ? { kind: "approve", arg: parsed.arg }
        : { kind: "denied-approve" };
    case "reject":
      return input.approveEnabled
        ? { kind: "reject", arg: parsed.arg }
        : { kind: "denied-approve" };
    default:
      return { kind: "help" };
  }
}
