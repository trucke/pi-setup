import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeText } from "./sanitize.ts";

export function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bounds model-facing output to the shared context limits and keeps the
 * complete text on disk when truncated.
 */
export async function boundedOutput(
  value: unknown,
  operation: string,
  extension = "md",
) {
  const output = sanitizeText(
    typeof value === "string" ? value : stringify(value),
  );
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return output;

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-web-search-"));
  const outputPath = join(outputDirectory, `${operation}.${extension}`);
  await writeFile(outputPath, output, "utf8");

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

export interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export function resultText(result: RenderableResult) {
  return result.content.find(
    (item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string",
  )?.text;
}

export function expandHint(theme: Theme) {
  return theme.fg("dim", keyHint("app.tools.expand", "to expand"));
}

export function errorResult(
  result: RenderableResult,
  theme: Theme,
  fallback: string,
) {
  return new Text(
    theme.fg(
      "error",
      sanitizeText(resultText(result) ?? "").trim() || fallback,
    ),
    0,
    0,
  );
}
