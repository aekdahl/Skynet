// ─── Copilot runner (W2d) ───────────────────────────────────────────────────
// GitHub Copilot agentic CLI (`copilot`), wrapped via the shared CliRunnerProvider.
// Selected with RUNNER=copilot. Auth is the CLI's own (GitHub login / GH_TOKEN);
// when the binary is absent the runner falls back to `review` with a clear reason.
// Note: the agentic `copilot` CLI is distinct from `gh copilot` (suggest/explain).

import { CliRunnerProvider, type CliRunnerSpec } from "./cli-runner.js";

const COPILOT: CliRunnerSpec = {
  id: "copilot",
  label: "Copilot",
  bin: "copilot",
  cmdEnv: "SKYNET_COPILOT_CMD",
  mapModel: () => undefined, // Copilot CLI selects its own model; no flag passed.
  // `-p "<prompt>"` programmatic form. Confirm flags against your CLI version.
  buildArgs: ({ task }) => ["-p", task],
};

export class CopilotRunnerProvider extends CliRunnerProvider {
  constructor() {
    super(COPILOT);
  }
}
