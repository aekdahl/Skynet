// mammoth ships no types (and none on DefinitelyTyped) — a minimal ambient
// declaration for the one function this codebase calls.
declare module "mammoth" {
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
}
