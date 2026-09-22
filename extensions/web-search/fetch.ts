import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  abortable,
  readPublicHttp,
  type PublicHttpOptions,
} from "../shared/public-http.ts";
import { boundedOutput, errorMessage } from "./output.ts";
import { FetchError, NETWORK_CODES } from "../shared/fetch-error.ts";
import { fetchHosted, normalizeHostedPage } from "./hosted-fetch.ts";
import type { CallHosted } from "./mcp.ts";
import { createRecoveryQueue, recoverFetch } from "./recovery.ts";
import { webRenderers } from "./render.ts";
import { sanitizeText } from "./sanitize.ts";

export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const ACCEPT =
  "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, application/json;q=0.7";

export async function extractHtml(html: string, url: string) {
  const [{ Readability }, { parseHTML }, { default: TurndownService }] =
    await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
      import("turndown"),
    ]);
  // linkedom never executes scripts or loads subresources.
  const { document } = parseHTML(html);
  const title = document.title;
  let base = url;
  const declaredBase = document
    .querySelector("base[href]")
    ?.getAttribute("href");
  if (declaredBase) {
    try {
      const candidate = new URL(declaredBase, url);
      if (["http:", "https:"].includes(candidate.protocol))
        base = candidate.href;
    } catch {
      /* Ignore malformed base declarations. */
    }
  }
  for (const node of document.querySelectorAll(
    "script, style, noscript, iframe, object, embed, form, template, base",
  ))
    node.remove();
  for (const node of document.querySelectorAll("[href], [src]")) {
    for (const attribute of ["href", "src"]) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const resolved = new URL(value, base);
        if (
          !["http:", "https:"].includes(resolved.protocol) ||
          resolved.username ||
          resolved.password
        )
          node.removeAttribute(attribute);
        else node.setAttribute(attribute, resolved.href);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }
  const fallback =
    document.querySelector("main")?.innerHTML ?? document.body.innerHTML;
  const article = new Readability(document as unknown as Document, {
    maxElemsToParse: 30_000,
  }).parse();
  const markdown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  }).turndown(article?.content || fallback);
  return {
    title: sanitizeText(article?.title || title),
    text: sanitizeText(markdown).trim(),
  };
}

export async function fetchLocal(
  url: string,
  options: { timeout?: number; signal?: AbortSignal } = {},
  transport: Pick<PublicHttpOptions, "request" | "resolve"> = {},
) {
  const timeoutMs = options.timeout ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new FetchError(
      "timeout must be between 1 and 120000 milliseconds.",
      "invalid",
    );
  const deadline = Date.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const response = await readPublicHttp(url, {
      ...transport,
      signal,
      maxBytes: MAX_FETCH_BYTES,
      accept: ACCEPT,
    });
    const mediaType = response.contentType
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const charset =
      response.contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ??
      "utf-8";
    const body = new TextDecoder(charset).decode(response.body);
    let text: string;
    let title: string | undefined;
    if (["text/html", "application/xhtml+xml"].includes(mediaType)) {
      ({ text, title } = await abortable(
        extractHtml(body, response.url),
        signal,
      ));
    } else if (
      mediaType.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType.endsWith("+json")
    ) {
      text = sanitizeText(body);
    } else {
      throw new FetchError(
        `Unsupported content type: ${mediaType || "missing"}. Use read-pdf for PDFs. No hosted request was made.`,
        "content",
      );
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error("Local extraction exceeded its deadline.");
    return {
      text:
        text ||
        "[No readable content. This may require JavaScript; no hosted request was made.]",
      details: {
        provider: "local" as const,
        url: response.url,
        contentType: sanitizeText(response.contentType).slice(0, 256),
        bytes: response.bytes,
        title: title?.slice(0, 300),
      },
    };
  } catch (error) {
    if (options.signal?.aborted)
      throw new FetchError("Local web fetch cancelled.", "cancelled");
    // A discovered unsafe destination remains terminal even near the deadline.
    if (error instanceof FetchError && !error.recoverable) throw error;
    if (timeout.aborted || Date.now() >= deadline)
      throw new FetchError(
        `Local web fetch timed out after ${timeoutMs / 1000} seconds. No hosted request was made.`,
        "timeout",
      );
    if (error instanceof FetchError) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (typeof code === "string" && NETWORK_CODES.has(code))
      throw new FetchError(
        `Local web fetch failed (${code}). No hosted request was made.`,
        "network",
        undefined,
        code,
      );
    throw new FetchError(errorMessage(error), "unknown");
  }
}

export function registerFetchTool(pi: ExtensionAPI, call: CallHosted) {
  const queue = createRecoveryQueue();
  pi.registerTool({
    name: "web-fetch",
    label: "Fetch Web Page",
    ...webRenderers("web-fetch"),
    description:
      "Read one public HTTP(S) URL locally first. HTML becomes readable Markdown; text, Markdown and JSON are returned directly. No JavaScript, cookies or credentials. Every redirect and DNS answer is validated and connections are pinned. Downloads are limited to 5 MiB and 30 seconds by default. Inline output is limited to 16KB or 400 lines, with complete extracted content saved to a temp file when truncated; use read for more. Eligible local failures offer per-request UI consent for Exa with Firecrawl fallback, plus a separately opt-in public GitHub reproduction report. Headless requests stay local.",
    promptSnippet:
      "Read a public URL locally, with optional per-request hosted recovery after UI consent.",
    promptGuidelines: [
      "Use web-fetch to read selected known URLs; do not re-fetch content already available unless freshness matters.",
      "web-fetch never silently discloses URLs to hosted providers. Respect declined consent; do not bypass it with web-fetch-hosted or other tools. Reporting requires the user to supply a non-sensitive public reproduction URL.",
    ],
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: "Public HTTP(S) URL to read.",
      }),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 120_000,
          description:
            "Local fetch/extraction timeout in milliseconds, excluding consent, hosted recovery and reporting. Default 30000; maximum 120000.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal = signal ?? ctx.signal;
      type Page = {
        text: string;
        details: {
          provider: string;
          url?: string;
          title?: string;
          bytes?: number;
          contentType?: string;
          fallbackReason?: string;
        };
      };
      const result = await recoverFetch<Page>({
        url: params.url,
        timeout: params.timeout ?? 30_000,
        ctx,
        signal: signal ?? new AbortController().signal,
        queue,
        local: () =>
          fetchLocal(params.url, { timeout: params.timeout, signal }),
        hosted: async () => {
          const result = await fetchHosted(call, { url: params.url }, signal);
          const page = normalizeHostedPage(result.provider, result.text);
          return {
            text: page.text,
            details: {
              ...page.details,
              provider: result.provider,
              fallbackReason: result.fallbackReason,
              url: params.url,
            },
          };
        },
      });
      const output = await boundedOutput(
        `Source: ${result.details.url}\nProvider: ${result.details.provider}${result.details.fallbackReason ? `\nFallback: ${result.details.fallbackReason}` : ""}${result.details.title ? `\nTitle: ${result.details.title}` : ""}\n\n${result.text}`,
        "web-fetch",
      );
      return {
        content: [{ type: "text", text: output.text }],
        details: {
          ...result.details,
          contentBytes: Buffer.byteLength(result.text),
          ...output.details,
        },
      };
    },
  });
}
