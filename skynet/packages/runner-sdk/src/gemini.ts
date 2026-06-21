// ─── Gemini runner (W2b) ────────────────────────────────────────────────────
// Google Gemini agentic CLI, wrapped via the shared CliRunnerProvider. Selected
// with RUNNER=gemini. Auth is the CLI's own (GEMINI_API_KEY / `gemini` login);
// when the binary is absent the runner falls back to `review` with a clear reason.

import { CliRunnerProvider, type CliRunnerSpec } from "./cli-runner.js";

const GEMINI: CliRunnerSpec = {
  id: "gemini",
  label: "Gemini",
  bin: "gemini",
  cmdEnv: "SKYNET_GEMINI_CMD",
  mapModel: (m) => m || undefined, // seed models are vendor ids ("gemini-3-pro")
  // `gemini -p "<prompt>"` is the non-interactive form. Confirm against your CLI version.
  buildArgs: ({ task, model }) => ["-p", task, ...(model ? ["-m", model] : [])],
};

export class GeminiRunnerProvider extends CliRunnerProvider {
  constructor() {
    super(GEMINI);
  }
}
