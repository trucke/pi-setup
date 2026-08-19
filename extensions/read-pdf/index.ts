import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CHARS = 50_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

type PageRange = { from: number; to: number };

function isUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveLocalPath(cwd: string, inputPath: string) {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

function parsePositiveInteger(value: string, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

export function parsePages(pages?: string): PageRange[] | undefined {
  if (!pages?.trim()) return undefined;

  const ranges: PageRange[] = [];
  for (const rawPart of pages.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match)
      throw new Error(
        `Invalid pages value: ${pages}. Use forms like "1", "1-3", or "1,3-5".`,
      );

    const from = parsePositiveInteger(match[1], "page");
    const to = match[2] ? parsePositiveInteger(match[2], "page") : from;
    if (to < from) throw new Error(`Invalid page range: ${part}`);
    ranges.push({ from, to });
  }

  return ranges.length ? ranges : undefined;
}

async function commandExists(command: string, signal?: AbortSignal) {
  try {
    await execFileAsync("/usr/bin/env", ["sh", "-c", `command -v ${command}`], {
      signal,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensurePoppler(signal?: AbortSignal) {
  const missing: string[] = [];
  if (!(await commandExists("pdfinfo", signal))) missing.push("pdfinfo");
  if (!(await commandExists("pdftotext", signal))) missing.push("pdftotext");
  if (missing.length) {
    throw new Error(
      `Missing PDF tools: ${missing.join(", ")}. Install Poppler, then reload Pi. macOS: brew install poppler. Debian/Ubuntu: sudo apt-get install poppler-utils.`,
    );
  }
}

async function downloadPdf(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`Download failed (${response.status}) for ${url}`);

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `PDF is too large (${contentLength} bytes). Limit is ${MAX_DOWNLOAD_BYTES} bytes.`,
    );
  }
  if (!response.body) throw new Error(`Download returned no body for ${url}`);

  const dir = await mkdtemp(join(tmpdir(), "pi-read-pdf-"));
  const parsed = new URL(url);
  const name = basename(parsed.pathname) || "download.pdf";
  const file = join(dir, name.endsWith(".pdf") ? name : `${name}.pdf`);

  try {
    const output = await open(file, "wx");
    try {
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          throw new Error(
            `PDF is too large (${bytes} bytes). Limit is ${MAX_DOWNLOAD_BYTES} bytes.`,
          );
        }
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    return { file, cleanupDir: dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function assertPdf(file: string) {
  const header = Buffer.alloc(5);
  const input = await open(file, "r");
  let bytesRead: number;
  try {
    ({ bytesRead } = await input.read(header, 0, header.length, 0));
  } finally {
    await input.close();
  }
  if (bytesRead !== header.length || !header.equals(Buffer.from("%PDF-"))) {
    throw new Error(`File does not look like a PDF: ${file}`);
  }
}

async function shortSha256(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(chunk);
  }
  return hash.digest("hex").slice(0, 16);
}

function parsePageCount(pdfinfoOutput: string) {
  const match = pdfinfoOutput.match(/^Pages:\s*(\d+)\s*$/im);
  return match ? Number(match[1]) : undefined;
}

async function boundedOutput(text: string, maxPreviewBytes: number) {
  const truncation = truncateHead(text, {
    maxBytes: Math.min(maxPreviewBytes, DEFAULT_MAX_BYTES),
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { text, truncated: false };

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-read-pdf-output-"));
  const outputPath = join(outputDirectory, "extraction.md");
  await writeFile(outputPath, text, "utf8");
  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`,
    truncated: true,
  };
}

async function extractRange(
  file: string,
  range: PageRange | undefined,
  layout: boolean,
  signal?: AbortSignal,
) {
  const args = ["-enc", "UTF-8"];
  if (layout) args.push("-layout");
  if (range) args.push("-f", String(range.from), "-l", String(range.to));
  args.push(file, "-");

  const { stdout } = await execFileAsync("pdftotext", args, {
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  return String(stdout);
}

function rangeLabel(range?: PageRange) {
  if (!range) return "all pages";
  return range.from === range.to
    ? `page ${range.from}`
    : `pages ${range.from}-${range.to}`;
}

export default function readPdfExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_pdf",
    label: "Read PDF",
    description:
      "Extract metadata and text from a local or URL PDF using Poppler tools.",
    promptSnippet:
      "Extract text and metadata from PDFs with page-range and truncation controls.",
    promptGuidelines: [
      "Use read_pdf for local PDF files or direct PDF URLs instead of converting PDFs to images when the user needs text content.",
      "Use read_pdf pages to limit extraction before reading large PDFs; ask for specific pages when the document is large or ambiguous.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Local PDF path or direct PDF URL." }),
      pages: Type.Optional(
        Type.String({
          description: "Optional pages, e.g. '1', '1-3', or '1,3-5'.",
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description:
            "Maximum preview size. Also bounded by Pi's standard byte and line limits. Default: 50000.",
        }),
      ),
      layout: Type.Optional(
        Type.Boolean({
          description:
            "Preserve physical layout with pdftotext -layout. Default: true.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      await ensurePoppler(signal);

      const maxChars = Math.max(
        1_000,
        Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, 500_000),
      );
      const layout = params.layout ?? true;
      const ranges = parsePages(params.pages);
      let cleanupDir: string | undefined;

      try {
        onUpdate?.({
          content: [{ type: "text", text: `Preparing PDF: ${params.path}` }],
          details: {},
        });

        let file: string;
        if (isUrl(params.path)) {
          const downloaded = await downloadPdf(params.path, signal);
          file = downloaded.file;
          cleanupDir = downloaded.cleanupDir;
        } else {
          file = resolveLocalPath(ctx.cwd, params.path);
          if (!existsSync(file)) throw new Error(`PDF not found: ${file}`);
        }

        await assertPdf(file);

        const { stdout: infoOutput } = await execFileAsync("pdfinfo", [file], {
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        const info = String(infoOutput).trim();
        const pageCount = parsePageCount(info);

        const selectedRanges = ranges ?? [undefined];
        const sections: string[] = [];
        for (const range of selectedRanges) {
          if (range && pageCount && range.to > pageCount) {
            throw new Error(
              `Requested ${rangeLabel(range)}, but PDF has ${pageCount} pages.`,
            );
          }
          onUpdate?.({
            content: [
              { type: "text", text: `Extracting ${rangeLabel(range)}...` },
            ],
            details: {},
          });
          const text = await extractRange(file, range, layout, signal);
          sections.push(
            `## ${rangeLabel(range)}\n\n${text.trim() || "[No extractable text found.]"}`,
          );
        }

        const sha256 = await shortSha256(file, signal);
        const combined = [
          `# PDF: ${params.path}`,
          `- Source: ${isUrl(params.path) ? "URL" : resolveLocalPath(ctx.cwd, params.path)}`,
          `- SHA-256: ${sha256}...`,
          pageCount ? `- Pages: ${pageCount}` : undefined,
          `- Extraction: pdftotext${layout ? " -layout" : ""}`,
          "",
          "## Metadata",
          "```text",
          info || "[No metadata returned.]",
          "```",
          "",
          ...sections,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n");

        const noText = sections.every((section) =>
          section.includes("[No extractable text found.]"),
        );
        const warning = noText
          ? "\n\nWarning: no extractable text was found. This may be a scanned/image-only PDF; render/OCR selected pages if visual content is needed."
          : "";
        const result = await boundedOutput(combined + warning, maxChars);

        return {
          content: [{ type: "text", text: result.text }],
          details: {
            pageCount,
            pages: params.pages,
            layout,
            maxChars,
            truncated: result.truncated,
          },
        };
      } finally {
        if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
      }
    },
  });
}
