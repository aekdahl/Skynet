// Shared guard for global (window-level) keyboard shortcuts: never hijack a
// key while the operator is typing in a text field, a textarea, or any
// contenteditable region (chat composer, modify guidance, task name, …).
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
