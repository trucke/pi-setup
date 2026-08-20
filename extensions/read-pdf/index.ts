import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const READ_PDF_TOOL_NAME = "read-pdf";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_PAGES = 100;
const MAX_MAX_CHARS = 500_000;
const MAX_MAX_PAGES = 1_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

type PageRange = { from: number; to: number };

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

function parseIpv4(address: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return undefined;
  const parts = address.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : undefined;
}

function ipv6Parts(address: string): number[] | undefined {
  let normalized = address.toLowerCase().split("%")[0];
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return undefined;
    normalized = normalized.slice(0, -ipv4Match[1].length);
    normalized += `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const parts = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16),
  );
  return parts.length === 8 && parts.every((part) => Number.isFinite(part))
    ? parts
    : undefined;
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const parts = parseIpv4(address);
    if (!parts) return false;
    const [a, b, c] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;

  const parts = ipv6Parts(address);
  if (!parts) return false;
  const [first, second, third, fourth, fifth, sixth] = parts;
  const isUnspecifiedOrLoopback =
    parts.slice(0, 7).every((part) => part === 0) && parts[7] <= 1;
  const isIpv4Compatible =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0;
  const isIpv4Mapped =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0xffff;
  if (isIpv4Mapped) {
    return isPublicIpAddress(
      `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`,
    );
  }

  return !(
    isUnspecifiedOrLoopback ||
    isIpv4Compatible ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8)
  );
}

export function parseRemotePdfUrl(input: string): URL | undefined {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return undefined;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid PDF URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PDF URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("PDF URLs must not contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`PDF URL destination is not public: ${url.hostname}`);
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error(`PDF URL destination is not public: ${url.hostname}`);
  }
  return url;
}

export function validateResolvedAddresses(addresses: readonly string[]) {
  if (addresses.length === 0)
    throw new Error("PDF URL hostname did not resolve.");
  const blocked = addresses.find((address) => !isPublicIpAddress(address));
  if (blocked) {
    throw new Error(`PDF URL resolved to a non-public address: ${blocked}`);
  }
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

async function downloadPdf(url: URL, signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
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

async function extractRange(
  file: string,
  range: PageRange,
  layout: boolean,
  signal?: AbortSignal,
) {
  const args = ["-enc", "UTF-8"];
  if (layout) args.push("-layout");
  args.push("-f", String(range.from), "-l", String(range.to), file, "-");

  const { stdout } = await execFileAsync("pdftotext", args, {
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  return String(stdout);
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

export default function readPdfExtension(pi: ExtensionAPI) {
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
      await ensurePoppler(signal);

      const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
      const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
      const layout = params.layout ?? true;
      const ranges = parsePages(params.pages);
      const remoteUrl = parseRemotePdfUrl(params.path);
      let cleanupDir: string | undefined;

      try {
        onUpdate?.({
          content: [{ type: "text", text: `Preparing PDF: ${params.path}` }],
          details: {},
        });

        let file: string;
        let source: string;
        if (remoteUrl) {
          const downloaded = await downloadPdf(remoteUrl, signal);
          file = downloaded.file;
          source = downloaded.finalUrl;
          cleanupDir = downloaded.cleanupDir;
        } else {
          file = resolveLocalPath(ctx.cwd, params.path);
          source = file;
          if (!existsSync(file)) throw new Error(`PDF not found: ${file}`);
        }

        await assertPdf(file);

        const { stdout: infoOutput } = await execFileAsync("pdfinfo", [file], {
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        const metadata = parsePdfInfo(String(infoOutput));
        if (!metadata.pageCount) {
          throw new Error("pdfinfo did not return a valid page count.");
        }
        const selection = selectPages(ranges, metadata.pageCount, maxPages);
        const groups = contiguousPageGroups(selection.pages);
        const extractedPages: ReturnType<typeof formatExtractedPages> = [];

        for (const group of groups) {
          onUpdate?.({
            content: [
              { type: "text", text: `Extracting ${rangeLabel(group)}...` },
            ],
            details: {},
          });
          const text = await extractRange(file, group, layout, signal);
          const pages = Array.from(
            { length: group.to - group.from + 1 },
            (_, index) => group.from + index,
          );
          extractedPages.push(...formatExtractedPages(text, pages));
        }

        const sha256 = await shortSha256(file, signal);
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

        const result = await boundOutput(combined, maxChars);
        return {
          content: [{ type: "text", text: result.text }],
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
      } finally {
        if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
      }
    },
  });
}
