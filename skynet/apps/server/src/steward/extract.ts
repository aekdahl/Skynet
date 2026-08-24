// ─── Context-entry text extraction ──────────────────────────────────────────
// Uploads are converted to plain text at ingest time and stored that way (see
// ProjectContextEntry.content) — never as raw binary. Keeps the store simple
// (one string field, same as a paste) and means condensation (steward/
// context.ts) never has to know about file formats.

import pdfParse from "pdf-parse";
import { extractRawText } from "mammoth";

/** Extracted content past this length is truncated — a single upload
 *  shouldn't be able to blow past what condensation can reasonably read (the
 *  LLM pass itself caps its own input further — see context.ts). */
export const MAX_EXTRACTED_CHARS = 200_000;

export class UnsupportedFileTypeError extends Error {
  constructor(mimeType: string, filename: string) {
    super(`Can't read "${filename}" (${mimeType || "unknown type"}) — supported: .txt, .md, .pdf, .docx.`);
    this.name = "UnsupportedFileTypeError";
  }
}

function truncate(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n… (truncated)` : text;
}

/** Extract plain text from an uploaded file's bytes, by extension (the
 *  browser-reported mimeType is unreliable across OSes/browsers — the
 *  filename's extension is the honest signal). Throws UnsupportedFileTypeError
 *  for anything else rather than silently storing garbage/binary as "content". */
export async function extractText(filename: string, mimeType: string, buffer: Buffer): Promise<string> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "txt":
    case "md":
      return truncate(buffer.toString("utf8"));
    case "pdf": {
      const { text } = await pdfParse(buffer);
      return truncate(text);
    }
    case "docx": {
      const { value } = await extractRawText({ buffer });
      return truncate(value);
    }
    default:
      throw new UnsupportedFileTypeError(mimeType, filename);
  }
}
