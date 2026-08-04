// ─── Telegram Bot API client (zero-dependency, global fetch) ────────────────
// The desktop app connects OUT to Telegram's HTTPS API — no inbound server, no
// open ports, no hosting. Four calls: long-poll getUpdates + sendMessage +
// answerCallbackQuery + editMessageReplyMarkup (the last two support inline
// keyboards — tap Confirm/Cancel instead of typing "yes"/"no").
//
// SECURITY: the bot token is a bearer secret embedded in the request URL. It is
// NEVER included in a thrown error, a log line, or any returned value — mirrors
// the repo convention ("Never log the secret itself"). Errors are scrubbed of
// the token before they surface so a caught+logged error can't leak it.

/** A single button on an inline keyboard. `callback_data` is limited to 64 bytes
 *  by Telegram; keep it short and opaque (e.g. `confirm:p-3`). */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}
/** An inline keyboard: rows of buttons attached to a message. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** A single inbound update (only the fields the bridge uses). */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
    /** Set when this message is a reply to another — we use it to route a reply
     *  to a decision card into that gate's "request changes" (modify) guidance. */
    reply_to_message?: { message_id: number };
  };
  /** A button on an inline keyboard was tapped. Telegram delivers this instead
   *  of a `message` when the source is a button — we handle it explicitly. */
  callback_query?: {
    id: string;
    /** The opaque `callback_data` from the button that was tapped. */
    data?: string;
    /** The message the button was attached to (so we can edit it to strip the
     *  buttons after acting). */
    message?: { message_id: number; chat: { id: number | string } };
    from: { id: number | string };
  };
}

/** What sendMessage returns — the id lets a caller edit the message later
 *  (e.g. strip inline buttons once the action has been resolved). */
export interface SentMessage {
  chatId: string | number;
  messageId: number;
}

export class TelegramClient {
  private readonly base: string;

  constructor(private readonly token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /** Remove the token from any string (defense-in-depth against leaks). */
  private scrub(s: string): string {
    return this.token ? s.split(this.token).join("<token>") : s;
  }

  /**
   * Long-poll for updates. Returns the updates array, or an EMPTY array on any
   * network/HTTP error so the caller can simply back off and retry — a transient
   * Telegram outage must never crash the poll loop. The token is never surfaced.
   */
  async getUpdates(offset: number, timeoutS: number): Promise<TelegramUpdate[]> {
    const url = `${this.base}/getUpdates?timeout=${timeoutS}&offset=${offset}`;
    try {
      // Give the socket slightly longer than the long-poll window before aborting.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (timeoutS + 10) * 1000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return [];
      const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      return body.ok && Array.isArray(body.result) ? body.result : [];
    } catch {
      // Network error / abort / bad JSON — treat as "no updates"; caller backs off.
      return [];
    }
  }

  /**
   * Send a message to a chat. Throws on failure (with a token-scrubbed message)
   * so the caller can decide whether to retry; notifications are best-effort at
   * the call site. Returns the sent message's chat id + message id — callers use
   * these to later edit the message (e.g. strip a resolved inline keyboard).
   * Pass `reply_markup` to attach inline buttons.
   */
  async sendMessage(
    chatId: string | number,
    text: string,
    opts?: { reply_markup?: InlineKeyboardMarkup; parse_mode?: "HTML" },
  ): Promise<SentMessage> {
    const url = `${this.base}/sendMessage`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...(opts?.parse_mode ? { parse_mode: opts.parse_mode } : {}),
          ...(opts?.reply_markup ? { reply_markup: opts.reply_markup } : {}),
        }),
      });
    } catch (err) {
      throw new Error(`telegram sendMessage failed: ${this.scrub((err as Error).message)}`);
    }
    if (!res.ok) {
      throw new Error(`telegram sendMessage HTTP ${res.status}`);
    }
    // Parse the id so callers can edit later. Best-effort: if the body is
    // malformed, return the chatId and a synthetic 0 — the caller only uses
    // messageId when it knows it stored one, so a fallback is safe.
    try {
      const body = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
      const messageId = body?.result?.message_id;
      return { chatId, messageId: typeof messageId === "number" ? messageId : 0 };
    } catch {
      return { chatId, messageId: 0 };
    }
  }

  /**
   * Replace the TEXT (and optionally the keyboard) of a previously-sent message.
   * Used to turn a live status card into its next state in place, or to render a
   * resolved decision card as "done". Best-effort: a 400 "message is not
   * modified" is swallowed (identical edit). Token is scrubbed from errors.
   */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    opts?: { reply_markup?: InlineKeyboardMarkup | null; parse_mode?: "HTML" },
  ): Promise<void> {
    const url = `${this.base}/editMessageText`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true,
          ...(opts?.parse_mode ? { parse_mode: opts.parse_mode } : {}),
          // Passing an empty keyboard removes the buttons; omitting leaves them.
          ...(opts?.reply_markup !== undefined
            ? { reply_markup: opts.reply_markup ?? { inline_keyboard: [] } }
            : {}),
        }),
      });
    } catch (err) {
      throw new Error(`telegram editMessageText failed: ${this.scrub((err as Error).message)}`);
    }
    if (!res.ok && res.status !== 400) {
      throw new Error(`telegram editMessageText HTTP ${res.status}`);
    }
  }

  /**
   * Acknowledge a callback_query — Telegram REQUIRES this to dismiss the
   * client's loading spinner on the tapped button (otherwise it spins for ~30s).
   * `text` shows a small toast in the client if provided; keep it short. Best-
   * effort: an error here doesn't break the bridge, so it's swallowed by the
   * caller if desired.
   */
  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void> {
    const url = `${this.base}/answerCallbackQuery`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(opts?.text ? { text: opts.text } : {}),
        }),
      });
    } catch (err) {
      throw new Error(`telegram answerCallbackQuery failed: ${this.scrub((err as Error).message)}`);
    }
    if (!res.ok) throw new Error(`telegram answerCallbackQuery HTTP ${res.status}`);
  }

  /**
   * Replace the reply_markup of a previously-sent message (used to strip inline
   * buttons after the action they attached to has been resolved, so the operator
   * can't double-tap and the message reads as done). Pass `null` to remove.
   */
  async editMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<void> {
    const url = `${this.base}/editMessageReplyMarkup`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          ...(replyMarkup ? { reply_markup: replyMarkup } : { reply_markup: { inline_keyboard: [] } }),
        }),
      });
    } catch (err) {
      throw new Error(`telegram editMessageReplyMarkup failed: ${this.scrub((err as Error).message)}`);
    }
    // Telegram returns 400 with "message is not modified" if the markup is
    // already the same — swallow that specific case since it's a no-op.
    if (!res.ok && res.status !== 400) {
      throw new Error(`telegram editMessageReplyMarkup HTTP ${res.status}`);
    }
  }
}
