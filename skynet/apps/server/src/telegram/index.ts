// ─── Telegram messaging bridge + remote kill switch ─────────────────────────
// The operator's installed desktop app connects OUT to Telegram (long-poll, no
// inbound server, no open ports). It pushes gate/run notifications to the owner's
// phone and accepts a few OWNER-ONLY slash-commands — including a kill switch to
// stop all processing (/stop) or quit the app (/quit).
//
// SECURITY MODEL (see commands.ts for the pure decision):
//   • Owner-bound — we act ONLY on messages whose chat.id equals the configured
//     owner chat id. Any other sender is ignored silently (logged WITHOUT
//     echoing the content).
//   • No free-text execution — only exact slash-commands are honored; any other
//     text gets a /help reply. Arbitrary text is NEVER run as an instruction.
//   • Approve-over-chat is opt-in (SKYNET_TELEGRAM_APPROVE=true, default OFF).
//     The kill switch (/stop, /quit) and /status always work regardless.
//   • The bot token is a secret — it is never logged (index.ts convention).

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ServerEvent } from "@skynet/shared";
import type { config as Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import type { Orchestrator } from "../orchestrator.js";
import { TelegramClient } from "./client.js";
import { decide } from "./commands.js";

const log = (line: string): void => console.log(`[telegram] ${line}`);

/** Exit code the desktop main (main.cjs) treats as an intentional remote quit. */
const REMOTE_SHUTDOWN_CODE = 42;

/** Long-poll window (seconds). Telegram holds the request open up to this long. */
const POLL_TIMEOUT_S = 30;

/** Backoff after a loop iteration throws, so a persistent error can't spin hot. */
const ERROR_BACKOFF_MS = 5_000;

const HELP =
  [
    "Skynet remote control:",
    "/status — running/waiting runs, open gates, pause state",
    "/gates — list open gates",
    "/approve <id> — approve a gate (if enabled)",
    "/reject <id> — reject a gate (if enabled)",
    "/stop — kill switch: halt all runs + pause autonomy",
    "/resume — re-enable autonomy",
    "/quit — shut down the Skynet app",
    "/help — this list",
  ].join("\n");

export interface TelegramBridgeDeps {
  config: typeof Config;
  bus: Bus;
  operations: Operations;
  orchestrator: Orchestrator;
}

export function startTelegramBridge(deps: TelegramBridgeDeps): void {
  const { config, bus, operations, orchestrator } = deps;
  const token = config.telegramBotToken;
  const ownerChatId = config.telegramOwnerChatId;

  if (!token || !ownerChatId) {
    log("telegram bridge disabled — set SKYNET_TELEGRAM_BOT_TOKEN + SKYNET_TELEGRAM_OWNER_CHAT_ID");
    return;
  }

  const client = new TelegramClient(token);

  /** Best-effort notify the owner; a Telegram outage must never break the bridge. */
  const notify = async (text: string): Promise<void> => {
    try {
      await client.sendMessage(ownerChatId, text);
    } catch (err) {
      // The client scrubs the token from its errors, so this is safe to log.
      log(`sendMessage failed: ${(err as Error).message}`);
    }
  };

  // ── Outbound: push workspace events to the owner ──────────────────────────
  const handler = (event: ServerEvent): void => {
    if (event.type === "hitl.raised") {
      const it = event.item;
      const lines = [`🔔 Gate ${it.id} (${it.kind}, risk ${it.risk}): ${it.title}`];
      if (it.command) lines.push(it.command);
      lines.push(`reply /approve ${it.id} or /reject ${it.id}`);
      void notify(lines.join("\n"));
    } else if (event.type === "run.status" && event.status === "review") {
      void notify(`⚠︎ Run ${event.runId} needs attention`);
    } else if (event.type === "run.completed") {
      void notify(`✅ Run ${event.runId} merged/done`);
    }
  };
  bus.subscribe(DEFAULT_WORKSPACE, handler);

  // ── Inbound: owner-only slash-commands ────────────────────────────────────
  const openGates = async () =>
    (await operations.listHitl(DEFAULT_WORKSPACE)).filter((h) => !h.resolvedAt);

  const handleMessage = async (chatId: string, text: string): Promise<void> => {
    const action = decide({ chatId, ownerChatId, approveEnabled: config.telegramApprove, text });

    // Owner-bound guardrail: never echo a non-owner's content.
    if (action.kind === "ignore") {
      log("ignored message from non-owner chat");
      return;
    }

    switch (action.kind) {
      case "help":
        await notify(HELP);
        return;

      case "status": {
        const runs = await operations.listRuns(DEFAULT_WORKSPACE);
        const active = runs.filter((r) => r.status === "running" || r.status === "waiting").length;
        const gates = (await openGates()).length;
        await notify(
          `Status: ${active} run(s) running/waiting, ${gates} open gate(s), autonomy ${
            orchestrator.isPaused() ? "PAUSED" : "active"
          }.`,
        );
        return;
      }

      case "gates": {
        const gates = await openGates();
        if (gates.length === 0) {
          await notify("No open gates.");
          return;
        }
        await notify(gates.map((g) => `${g.id} — ${g.kind} — ${g.title}`).join("\n"));
        return;
      }

      case "approve":
      case "reject": {
        const gates = await openGates();
        // Use the supplied id, or the single open gate when there's exactly one.
        let id = action.arg;
        if (!id) {
          if (gates.length === 1) id = gates[0]!.id;
          else if (gates.length === 0) {
            await notify("No open gates to act on.");
            return;
          } else {
            await notify(`Which gate? ${gates.length} open — reply /${action.kind} <id>. See /gates.`);
            return;
          }
        }
        const decision = action.kind === "approve" ? "approve" : "reject";
        try {
          await operations.resolveHitl(
            DEFAULT_WORKSPACE,
            id,
            { action: decision },
            `telegram:${ownerChatId}`,
          );
          await notify(`${decision === "approve" ? "✅" : "🚫"} Gate ${id} ${decision}d.`);
        } catch (err) {
          await notify(`Couldn't ${decision} gate ${id}: ${(err as Error).message}`);
        }
        return;
      }

      case "denied-approve":
        await notify(
          "Approval over chat is disabled (set SKYNET_TELEGRAM_APPROVE=true). Open the app to decide.",
        );
        return;

      case "stop": {
        const n = await orchestrator.stopAll("kill switch via Telegram");
        await notify(`🛑 Stopped ${n} run(s); autonomy paused. /resume to re-enable.`);
        return;
      }

      case "resume":
        orchestrator.setPaused(false);
        await notify("▶️ Autonomy resumed.");
        return;

      case "quit": {
        await notify("🛑 Shutting down Skynet…");
        await orchestrator.stopAll("shutdown via Telegram /quit").catch(() => undefined);
        // The desktop main treats 42 as an intentional remote shutdown (no crash box).
        process.exit(REMOTE_SHUTDOWN_CODE);
        return;
      }
    }
  };

  // Long-poll loop — fire-and-forget (never awaited at boot). Each iteration is
  // isolated: an error is caught + backed off so the loop survives, and it never
  // throws out of startTelegramBridge.
  const loop = async (): Promise<void> => {
    let offset = 0;
    log("telegram bridge active — owner-bound remote control online");
    for (;;) {
      try {
        const updates = await client.getUpdates(offset, POLL_TIMEOUT_S);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1); // ack past this update
          const msg = u.message;
          if (!msg || typeof msg.text !== "string") continue;
          await handleMessage(String(msg.chat.id), msg.text).catch((err) =>
            log(`handler error: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        // getUpdates already swallows network errors, but guard the whole body so
        // nothing can escape the loop; back off before retrying.
        log(`poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
  };

  void loop();
}
