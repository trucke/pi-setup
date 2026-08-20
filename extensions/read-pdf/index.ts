import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Data, Effect, Exit, ManagedRuntime } from "effect";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  isPublicIpAddress,
  parsePublicHttpUrl,
  validateResolvedAddresses,
} from "../shared/public-url.ts";

export {
  isPublicIpAddress,
  validateResolvedAddresses,
} from "../shared/public-url.ts";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  PdfProcessError,
  PdfProcessTimeoutError,
  runPdfCommand,
} from "./process.ts";

export const READ_PDF_TOOL_NAME = "read-pdf";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_PAGES = 100;
const MAX_MAX_CHARS = 500_000;
const MAX_MAX_PAGES = 1_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const POPPLER_PROBE_TIMEOUT_MS = 5_000;
const PDFINFO_TIMEOUT_MS = 30_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

class PdfError extends Data.TaggedError("PdfError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type PageRange = { from: number; to: number };

type PdfSource = {
  file: string;
  source: string;
  cleanupDir?: string;
};

type PdfMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  creationDate?: string;
  encrypted?: boolean;
  encryptionDetails?: string;
  pageCount?: number;
  fields: Record<string, string>;
  raw: string;
};

type PageSelection = {
  pages: number[];
  requestedPageCount: number;
  budgetTruncated: boolean;
  explicit: boolean;
};

function resolveLocalPath(cwd: string, inputPath: string) {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

function parsePositiveInteger(value: string, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function parsePages(pages?: string): PageRange[] | undefined {
  if (!pages?.trim()) return undefined;

  const ranges: PageRange[] = [];
  for (const rawPart of pages.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(
        `Invalid pages value: ${pages}. Use forms like "1", "1-3", or "1,3-5".`,
      );
    }

    const from = parsePositiveInteger(match[1], "page");
    const to = match[2] ? parsePositiveInteger(match[2], "page") : from;
    if (to < from) throw new Error(`Invalid page range: ${part}`);
    ranges.push({ from, to });
  }

  return ranges.length ? ranges : undefined;
}

export function selectPages(
  ranges: PageRange[] | undefined,
  pageCount: number,
  maxPages: number,
): PageSelection {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("Could not determine a valid PDF page count.");
  }

  const requested: number[] = [];
  const seen = new Set<number>();
  if (ranges) {
    for (const range of ranges) {
      if (range.to > pageCount) {
        throw new Error(
          `Requested ${range.from === range.to ? `page ${range.from}` : `pages ${range.from}-${range.to}`}, but PDF has ${pageCount} pages.`,
        );
      }
      for (let page = range.from; page <= range.to; page += 1) {
        if (!seen.has(page)) {
          requested.push(page);
          seen.add(page);
        }
      }
    }
  } else {
    for (let page = 1; page <= pageCount; page += 1) requested.push(page);
  }

  return {
    pages: requested.slice(0, maxPages),
    requestedPageCount: requested.length,
    budgetTruncated: requested.length > maxPages,
    explicit: ranges !== undefined,
  };
}

function contiguousPageGroups(pages: number[]): PageRange[] {
  const groups: PageRange[] = [];
  for (const page of pages) {
    const previous = groups.at(-1);
    if (previous && page === previous.to + 1) previous.to = page;
    else groups.push({ from: page, to: page });
  }
  return groups;
}

export function formatExtractedPages(text: string, pages: number[]) {
  const chunks = text.replaceAll("\r\n", "\n").split("\f");
  while (chunks.length > pages.length && chunks.at(-1)?.trim() === "") {
    chunks.pop();
  }
  if (chunks.length > pages.length && pages.length > 0) {
    chunks[pages.length - 1] = chunks.slice(pages.length - 1).join("\n");
    chunks.length = pages.length;
  }

  return pages.map((page, index) => {
    const content = chunks[index]?.trim() ?? "";
    return {
      page,
      hasText: content.length > 0,
      text: `## Page ${page}\n\n${content || "[No extractable text found on this page.]"}`,
    };
  });
}

export function parsePdfInfo(output: string): PdfMetadata {
  const raw = output.trim();
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  const pages = fields.Pages ? Number(fields.Pages) : undefined;
  const encryption = fields.Encrypted;
  const encryptionMatch = encryption?.match(/^(yes|no)\b\s*(.*)$/i);

  return {
    title: fields.Title || undefined,
    author: fields.Author || undefined,
    subject: fields.Subject || undefined,
    creationDate: fields.CreationDate || undefined,
    encrypted: encryptionMatch
      ? encryptionMatch[1].toLowerCase() === "yes"
      : undefined,
    encryptionDetails: encryptionMatch?.[2] || undefined,
    pageCount:
      pages !== undefined && Number.isSafeInteger(pages) && pages > 0
        ? pages
        : undefined,
    fields,
    raw,
  };
}

export function parseRemotePdfUrl(input: string): URL | undefined {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return undefined;
  return parsePublicHttpUrl(input, "PDF URL");
}

function probePoppler(command: "pdfinfo" | "pdftotext") {
  return runPdfCommand({
    command,
    args: ["-v"],
    maxStdoutBytes: 64 * 1024,
    timeoutMs: POPPLER_PROBE_TIMEOUT_MS,
  }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function ensurePoppler() {
  return Effect.gen(function* () {
    const available = yield* Effect.all(
      {
        pdfinfo: probePoppler("pdfinfo"),
        pdftotext: probePoppler("pdftotext"),
      },
      { concurrency: "unbounded" },
    );
    const missing = [
      available.pdfinfo ? undefined : "pdfinfo",
      available.pdftotext ? undefined : "pdftotext",
    ].filter((command): command is string => command !== undefined);
    if (missing.length > 0) {
      return yield* new PdfError({
        message: `Missing PDF tools: ${missing.join(", ")}. Install Poppler, then reload Pi. macOS: brew install poppler. Debian/Ubuntu: sudo apt-get install poppler-utils.`,
      });
    }
  });
}

async function requestUrl(
  url: URL,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ response: IncomingMessage; finalUrl: URL }> {
  if (redirects > MAX_REDIRECTS) {
    throw new Error(`PDF download exceeded ${MAX_REDIRECTS} redirects.`);
  }
  parseRemotePdfUrl(url.href);
  signal.throwIfAborted();

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolved = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("PDF download cancelled.")),
            { once: true },
          );
        }),
      ]);
  signal.throwIfAborted();
  validateResolvedAddresses(resolved.map(({ address }) => address));
  const pinned = resolved[0];
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, pinned.address, pinned.family);
  };

  const response = await new Promise<IncomingMessage>(
    (resolveResponse, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          headers: {
            Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
            "Accept-Encoding": "identity",
            "User-Agent": "pi-read-pdf/1",
          },
          lookup: pinnedLookup,
          signal,
        },
        resolveResponse,
      );
      request.once("error", reject);
      request.end();
    },
  );

  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    const location = response.headers.location;
    response.resume();
    if (!location)
      throw new Error("PDF download redirect had no Location header.");
    const redirected = new URL(location, url);
    parseRemotePdfUrl(redirected.href);
    return requestUrl(redirected, signal, redirects + 1);
  }
  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
    response.resume();
    throw new Error(`Download failed (${response.statusCode}) for ${url.href}`);
  }
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding.toLowerCase() !== "identity") {
    response.destroy();
    throw new Error(`Unexpected PDF content encoding: ${encoding}`);
  }
  return { response, finalUrl: url };
}

async function downloadPdf(url: URL, signal: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = AbortSignal.any([signal, timeoutSignal]);
  try {
    return await downloadPdfWithSignal(url, downloadSignal);
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) {
      throw new Error(
        `PDF download timed out after ${DOWNLOAD_TIMEOUT_MS / 1_000} seconds.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function downloadPdfWithSignal(url: URL, downloadSignal: AbortSignal) {
  const { response, finalUrl } = await requestUrl(url, downloadSignal);

  const contentLength = response.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    response.destroy();
    throw new Error(
      `PDF is too large (${contentLength} bytes). Limit is ${MAX_DOWNLOAD_BYTES} bytes.`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-read-pdf-"));
  const name = basename(finalUrl.pathname) || "download.pdf";
  const file = join(
    dir,
    name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
  );

  try {
    const output = await open(file, "wx");
    try {
      let bytes = 0;
      for await (const chunk of response) {
        downloadSignal.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          response.destroy();
          throw new Error(
            `PDF is too large (${bytes} bytes). Limit is ${MAX_DOWNLOAD_BYTES} bytes.`,
          );
        }
        await output.write(buffer);
      }
    } finally {
      await output.close();
    }
    return { file, cleanupDir: dir, finalUrl: finalUrl.href };
  } catch (error) {
    response.destroy();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function pdfError(cause: unknown) {
  return cause instanceof PdfError ||
    cause instanceof PdfProcessError ||
    cause instanceof PdfProcessTimeoutError
    ? cause
    : new PdfError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
}

function tryPdf<A>(tryValue: () => A) {
  return Effect.try({ try: tryValue, catch: pdfError });
}

function tryPdfPromise<A>(tryValue: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: tryValue, catch: pdfError });
}

function acquirePdfSource(
  remoteUrl: URL | undefined,
  inputPath: string,
  cwd: string,
) {
  if (!remoteUrl) {
    return tryPdf(() => {
      const file = resolveLocalPath(cwd, inputPath);
      if (!existsSync(file)) throw new Error(`PDF not found: ${file}`);
      return { file, source: file } satisfies PdfSource;
    });
  }

  return Effect.acquireRelease(
    tryPdfPromise((signal) => downloadPdf(remoteUrl, signal)).pipe(
      Effect.map(
        (downloaded) =>
          ({
            file: downloaded.file,
            source: downloaded.finalUrl,
            cleanupDir: downloaded.cleanupDir,
          }) satisfies PdfSource,
      ),
    ),
    ({ cleanupDir }) =>
      cleanupDir
        ? Effect.tryPromise({
            try: () => rm(cleanupDir, { recursive: true, force: true }),
            catch: pdfError,
          }).pipe(Effect.orDie)
        : Effect.void,
  );
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
  for await (const chunk of createReadStream(file, { signal }))
    hash.update(chunk);
  return hash.digest("hex").slice(0, 16);
}

export function truncateByCharacters(text: string, maxChars: number) {
  const characters = Array.from(text);
  return {
    content: characters.slice(0, maxChars).join(""),
    totalChars: characters.length,
    outputChars: Math.min(characters.length, maxChars),
    truncated: characters.length > maxChars,
  };
}

export function createBoundedPreview(text: string, maxChars: number) {
  const characters = truncateByCharacters(text, maxChars);
  const standard = truncateHead(characters.content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return {
    content: standard.content,
    characterTruncated: characters.truncated,
    standardTruncated: standard.truncated,
    totalChars: characters.totalChars,
    outputChars: Array.from(standard.content).length,
    standard,
    truncated: characters.truncated || standard.truncated,
  };
}

async function boundOutput(text: string, maxChars: number) {
  const preview = createBoundedPreview(text, maxChars);
  if (!preview.truncated) return { text, preview, fullOutputPath: undefined };

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-read-pdf-output-"));
  const outputPath = join(outputDirectory, "extraction.md");
  await writeFile(outputPath, text, "utf8");
  const reasons = [
    preview.characterTruncated
      ? `${preview.outputChars} of ${preview.totalChars} characters shown (maxChars)`
      : undefined,
    preview.standardTruncated
      ? `${preview.standard.outputLines} of ${preview.standard.totalLines} lines and ${formatSize(preview.standard.outputBytes)} of ${formatSize(preview.standard.totalBytes)} shown (Pi limits)`
      : undefined,
  ].filter((reason): reason is string => reason !== undefined);

  const notice = `[Output truncated: ${reasons.join("; ")}. Full extracted output saved to: ${outputPath}]`;
  const boundedPreview = truncateHead(preview.content, {
    maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(notice) - 2),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 2),
  });

  return {
    text: `${boundedPreview.content}\n\n${notice}`,
    preview: {
      ...preview,
      content: boundedPreview.content,
      outputChars: Array.from(boundedPreview.content).length,
      standardTruncated: preview.standardTruncated || boundedPreview.truncated,
      truncated: true,
    },
    fullOutputPath: outputPath,
  };
}

function extractRange(file: string, range: PageRange, layout: boolean) {
  const args = ["-enc", "UTF-8"];
  if (layout) args.push("-layout");
  args.push("-f", String(range.from), "-l", String(range.to), file, "-");

  return runPdfCommand({
    command: "pdftotext",
    args,
    maxStdoutBytes: 32 * 1024 * 1024,
    timeoutMs: PDFTOTEXT_TIMEOUT_MS,
  });
}

function rangeLabel(range: PageRange) {
  return range.from === range.to
    ? `page ${range.from}`
    : `pages ${range.from}-${range.to}`;
}

function metadataHeader(metadata: PdfMetadata) {
  return [
    metadata.title ? `- Title: ${metadata.title}` : undefined,
    metadata.author ? `- Author: ${metadata.author}` : undefined,
    metadata.subject ? `- Subject: ${metadata.subject}` : undefined,
    metadata.creationDate ? `- Created: ${metadata.creationDate}` : undefined,
    metadata.encrypted !== undefined
      ? `- Encrypted: ${metadata.encrypted ? "yes" : "no"}${metadata.encryptionDetails ? ` (${metadata.encryptionDetails})` : ""}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
}

function createPdfRuntime() {
  return ManagedRuntime.make(NodeServices.layer);
}

type PdfRuntime = ReturnType<typeof createPdfRuntime>;

export default function readPdfExtension(pi: ExtensionAPI) {
  let runtime: PdfRuntime | undefined;
  const getRuntime = () => (runtime ??= createPdfRuntime());

  pi.registerTool({
    name: READ_PDF_TOOL_NAME,
    label: "Read PDF",
    description: `Extract metadata and text from a local or HTTP(S) PDF using Poppler. Extraction defaults to ${DEFAULT_MAX_PAGES} pages. Output is limited by maxChars and Pi's ${DEFAULT_MAX_LINES}-line/${formatSize(DEFAULT_MAX_BYTES)} bounds; complete extracted output is saved to a temp file when preview truncation occurs.`,
    promptSnippet:
      "Extract text and metadata from PDFs with page-range, page-budget, and truncation controls.",
    promptGuidelines: [
      "Use read-pdf for local PDF files or direct PDF URLs instead of converting PDFs to images when the user needs text content.",
      "Use read-pdf pages to limit extraction before reading large PDFs; ask for specific pages when the document is large or ambiguous.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Local PDF path or direct HTTP(S) PDF URL.",
      }),
      pages: Type.Optional(
        Type.String({
          description: "Optional pages, e.g. '1', '1-3', or '1,3-5'.",
        }),
      ),
      maxPages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_MAX_PAGES,
          description: `Maximum pages to extract. Default: ${DEFAULT_MAX_PAGES}.`,
        }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_MAX_CHARS,
          description: `Maximum characters in the preview before Pi's byte and line bounds. Default: ${DEFAULT_MAX_CHARS}.`,
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
      const program = Effect.gen(function* () {
        yield* ensurePoppler();

        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
        const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
        const layout = params.layout ?? true;
        const ranges = yield* tryPdf(() => parsePages(params.pages));
        const remoteUrl = yield* tryPdf(() => parseRemotePdfUrl(params.path));

        yield* Effect.sync(() =>
          onUpdate?.({
            content: [{ type: "text", text: `Preparing PDF: ${params.path}` }],
            details: {},
          }),
        );

        const { file, source } = yield* acquirePdfSource(
          remoteUrl,
          params.path,
          ctx.cwd,
        );
        yield* tryPdfPromise(() => assertPdf(file));

        const infoOutput = yield* runPdfCommand({
          command: "pdfinfo",
          args: [file],
          maxStdoutBytes: 2 * 1024 * 1024,
          timeoutMs: PDFINFO_TIMEOUT_MS,
        });
        const metadata = parsePdfInfo(infoOutput);
        const pageCount = metadata.pageCount;
        if (!pageCount) {
          return yield* new PdfError({
            message: "pdfinfo did not return a valid page count.",
          });
        }
        const selection = yield* tryPdf(() =>
          selectPages(ranges, pageCount, maxPages),
        );
        const groups = contiguousPageGroups(selection.pages);
        const extractedPages: ReturnType<typeof formatExtractedPages> = [];

        for (const group of groups) {
          yield* Effect.sync(() =>
            onUpdate?.({
              content: [
                { type: "text", text: `Extracting ${rangeLabel(group)}...` },
              ],
              details: {},
            }),
          );
          const text = yield* extractRange(file, group, layout);
          const pages = Array.from(
            { length: group.to - group.from + 1 },
            (_, index) => group.from + index,
          );
          extractedPages.push(...formatExtractedPages(text, pages));
        }

        const sha256 = yield* tryPdfPromise((effectSignal) =>
          shortSha256(file, effectSignal),
        );
        const budgetNotice = selection.budgetTruncated
          ? `> [Page budget reached: extracted ${selection.pages.length} of ${selection.requestedPageCount} requested pages. Increase maxPages or request a narrower range to continue.]`
          : undefined;
        const extractablePageCount = extractedPages.filter(
          ({ hasText }) => hasText,
        ).length;
        const imageOnlyLikely = extractablePageCount === 0;
        const scanNotice = imageOnlyLikely
          ? "> [No extractable text was found on the selected pages. This PDF is likely scanned or image-only. OCR is not provided by read-pdf; use a separate OCR-capable workflow on specific relevant pages if their visual content is needed.]"
          : undefined;
        const combined = [
          `# PDF: ${params.path}`,
          `- Source: ${source}`,
          `- SHA-256: ${sha256}...`,
          `- Pages: ${metadata.pageCount}`,
          `- Selected: ${selection.pages.length} page${selection.pages.length === 1 ? "" : "s"}`,
          `- Extraction: pdftotext${layout ? " -layout" : ""}`,
          ...metadataHeader(metadata),
          "",
          budgetNotice,
          scanNotice,
          budgetNotice || scanNotice ? "" : undefined,
          "## Raw pdfinfo metadata",
          "```text",
          metadata.raw || "[No metadata returned.]",
          "```",
          "",
          ...extractedPages.map(({ text }) => text),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n");

        const result = yield* tryPdfPromise(() =>
          boundOutput(combined, maxChars),
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            metadata,
            pageCount: metadata.pageCount,
            pages: params.pages,
            selectedPages: selection.pages,
            requestedPageCount: selection.requestedPageCount,
            maxPages,
            budgetTruncated: selection.budgetTruncated,
            layout,
            maxChars,
            truncated: result.preview.truncated,
            characterTruncated: result.preview.characterTruncated,
            standardTruncated: result.preview.standardTruncated,
            fullOutputPath: result.fullOutputPath,
            extractablePageCount,
            imageOnlyLikely,
            guidance: imageOnlyLikely
              ? "No text layer was detected. Use a separate OCR-capable workflow on selected pages if visual content is needed."
              : undefined,
          },
        };
      }).pipe(Effect.scoped);

      const exit = await getRuntime().runPromiseExit(
        program,
        signal ? { signal } : undefined,
      );
      if (Exit.isSuccess(exit)) return exit.value;
      if (signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error("PDF extraction cancelled.");
      }
      const [first] = Cause.prettyErrors(exit.cause);
      throw new Error(first?.message ?? Cause.pretty(exit.cause));
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });
}
