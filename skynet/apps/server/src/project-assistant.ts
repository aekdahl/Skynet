// ─── Project assistant → Steward (compat shim) ──────────────────────────────
// The project assistant is now "Steward", the shared repo-aware assistant brain
// (apps/server/src/steward/). This module re-exports it under the original names
// so existing callers (operations.ts, telegram) keep working unchanged; the
// canonical entry points are askSteward / askStewardStream.

export type {
  ChatTurn,
  ProjectActionKind,
  AssistantAction,
  ProjectActionContext,
  StewardCall,
} from "./steward/assistant.js";
export {
  prefetchProjectDocs,
  validateProjectAction,
  splitProposedAction,
  prepareStewardCall,
  askSteward,
  askStewardStream,
  // Back-compat alias for the original project-assistant name.
  askSteward as answerProjectQuestion,
} from "./steward/assistant.js";
