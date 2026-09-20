import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { sanitizeText } from "./sanitize.ts";

export function errorMessage(error: unknown) {
  return sanitizeText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1000);
}

const MAX_BYTES = 16 * 1024;
const MAX_LINES = 400;

/**
 * truncateHead only keeps whole lines, so one over-budget line (minified JSON)
 * would leave an empty preview. Keep a partial final line instead.
 */
function head(text: string, maxBytes: number, maxLines: number) {
  const bytes = Buffer.from(text.split("\n", maxLines).join("\n"));
  let end = Math.min(maxBytes, bytes.length);
  // Never split a UTF-8 sequence: back up while the next byte is a continuation.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Keep inline content modest; preserve the complete sanitized text for read.
 * Spread `details` into the tool result: `savedPath` is the trusted source for
 * UI, because the model-facing notice can be imitated by page content.
 */
export async function boundedOutput(
  value: string,
  operation: string,
): Promise<{ text: string; details: { savedPath?: string } }> {
  const output = sanitizeText(value);
  const { truncated } = truncateHead(output, {
    maxBytes: MAX_BYTES,
    maxLines: MAX_LINES,
  });
  if (!truncated) return { text: output, details: {} };
  const directory = await mkdtemp(join(tmpdir(), "pi-web-output-"));
  const path = join(directory, `${operation}.md`);
  await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
  const notice = `[Output truncated. Use read for more. Full output saved to: ${path}]`;
  const preview = head(
    output,
    MAX_BYTES - Buffer.byteLength(notice) - 2,
    MAX_LINES - 2,
  );
  return { text: `${preview}\n\n${notice}`, details: { savedPath: path } };
}
