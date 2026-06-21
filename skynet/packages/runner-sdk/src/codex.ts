// ─── Codex runner (W2a) ─────────────────────────────────────────────────────
// OpenAI Codex agentic CLI, wrapped via the shared CliRunnerProvider. Selected
// with RUNNER=codex. Auth is the CLI's own (OPENAI_API_KEY / `codex login`); when
// the binary is absent the runner falls back to `review` with a clear reason.

import { CliRunnerProvider, type CliRunnerSpec } from "./cli-runner.js";

const CODEX: CliRunnerSpec = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  cmdEnv: "SKYNET_CODEX_CMD",
  // Seed models are already vendor model ids ("gpt-5.2-codex"); pass through.
  mapModel: (m) => m || undefined,
  // `codex exec` is the non-interactive form. Confirm flags against your CLI version.
  buildArgs: ({ task, model }) => ["exec", ...(model ? ["-m", model] : []), task],
};

export class CodexRunnerProvider extends CliRunnerProvider {
  constructor() {
    super(CODEX);
  }
}
