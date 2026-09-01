// Parsing for the streaming Steward reply. The server writes the prose reply as
// text deltas, then a record-separator (\x1e) sentinel followed by a JSON control
// frame — {reply, actions, projectId} — carrying the CLEAN reply (trailing action
// JSON stripped) and any confirm-first actions (a batch). Pure + transport-agnostic
// (takes an async iterable of decoded string chunks) so it's unit-testable.

import type { AssistantAction } from "./client";
import type { SourceRef } from "@skynet/shared";

export const STEWARD_SENTINEL = "\x1e";

export interface StewardReply {
  reply: string;
  actions?: AssistantAction[];
  projectId?: string | null;
  sources?: SourceRef[];
}

/**
 * Consume the streamed chunks: forward the prose (everything before the sentinel)
 * to `onDelta` exactly once each, then parse the control frame after it. Returns
 * the authoritative reply — the caller reconciles its live-streamed text to this
 * (so an action JSON that streamed through before the sentinel is cleaned up).
 */
export async function parseStewardStream(
  chunks: AsyncIterable<string>,
  onDelta: (chunk: string) => void,
): Promise<StewardReply> {
  let acc = "";
  let emitted = 0; // prose chars already handed to onDelta
  let sentinel = -1;
  for await (const chunk of chunks) {
    acc += chunk;
    if (sentinel < 0) sentinel = acc.indexOf(STEWARD_SENTINEL);
    const textEnd = sentinel < 0 ? acc.length : sentinel;
    if (textEnd > emitted) {
      onDelta(acc.slice(emitted, textEnd));
      emitted = textEnd;
    }
  }
  const streamed = sentinel < 0 ? acc : acc.slice(0, sentinel);
  if (sentinel < 0) return { reply: streamed };
  try {
    const ctrl = JSON.parse(acc.slice(sentinel + 1)) as StewardReply;
    return {
      reply: ctrl.reply ?? streamed,
      actions: ctrl.actions ?? [],
      projectId: ctrl.projectId ?? null,
      sources: ctrl.sources ?? [],
    };
  } catch {
    // Malformed trailer — keep the streamed prose as the reply.
    return { reply: streamed };
  }
}
