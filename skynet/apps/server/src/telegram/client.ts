// ─── Telegram Bot API client (zero-dependency, global fetch) ────────────────
// The desktop app connects OUT to Telegram's HTTPS API — no inbound server, no
// open ports, no hosting. Just two calls: long-poll getUpdates + sendMessage.
//
// SECURITY: the bot token is a bearer secret embedded in the request URL. It is
// NEVER included in a thrown error, a log line, or any returned value — mirrors
// the repo convention ("Never log the secret itself"). Errors are scrubbed of
// the token before they surface so a caught+logged error can't leak it.

/** A single inbound update (only the fields the bridge uses). */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
  };
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
   * Send a plain-text message to a chat. Throws on failure (with a token-scrubbed
   * message) so the caller can decide whether to retry; notifications are
   * best-effort at the call site.
   */
  async sendMessage(chatId: string | number, text: string): Promise<void> {
    const url = `${this.base}/sendMessage`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
    } catch (err) {
      throw new Error(`telegram sendMessage failed: ${this.scrub((err as Error).message)}`);
    }
    if (!res.ok) {
      throw new Error(`telegram sendMessage HTTP ${res.status}`);
    }
  }
}
