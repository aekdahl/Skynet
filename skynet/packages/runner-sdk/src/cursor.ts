// ─── Cursor runner (W2c) ────────────────────────────────────────────────────
// Cursor Agent CLI (`cursor-agent`), wrapped via the shared CliRunnerProvider.
// Selected with RUNNER=cursor. Auth is the CLI's own (CURSOR_API_KEY /
// `cursor-agent login`); when the binary is absent the runner falls back to
// `review`. Flags below are from `cursor-agent --help` (v non-interactive mode).

import { CliRunnerProvider, type CliRunnerSpec } from "./cli-runner.js";

// `cursor-agent --model` takes vendor names (gpt-5, sonnet-4, …), not Skynet's
// seed ids. Map the ones we know; omit the flag otherwise (CLI default).
const MODEL_MAP: Record<string, string> = {
  "composer-2": "composer-2",
  "gpt-5": "gpt-5",
  "sonnet-4": "sonnet-4",
  "sonnet-4-thinking": "sonnet-4-thinking",
};

const CURSOR: CliRunnerSpec = {
  id: "cursor",
  label: "Cursor",
  bin: "cursor-agent",
  cmdEnv: "SKYNET_CURSOR_CMD",
  mapModel: (m) => MODEL_MAP[m],
  // `-p` = non-interactive print mode (full tool access); stream as plain text.
  buildArgs: ({ task, model }) => [
    "-p",
    task,
    "--output-format",
    "text",
    ...(model ? ["--model", model] : []),
  ],
};

export class CursorRunnerProvider extends CliRunnerProvider {
  constructor() {
    super(CURSOR);
  }
}
