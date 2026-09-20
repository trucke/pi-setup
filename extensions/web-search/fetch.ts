import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  abortable,
  readPublicHttp,
  type PublicHttpOptions,
} from "../shared/public-http.ts";
import { boundedOutput, errorMessage } from "./output.ts";
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
    throw new Error("timeout must be between 1 and 120000 milliseconds.");
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
      throw new Error(
        `Unsupported content type: ${mediaType || "missing"}. Use read-pdf for PDFs. No hosted request was made.`,
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
    if (options.signal?.aborted) throw new Error("Local web fetch cancelled.");
    if (timeout.aborted || Date.now() >= deadline)
      throw new Error(
        `Local web fetch timed out after ${timeoutMs / 1000} seconds. No hosted request was made.`,
      );
    throw new Error(errorMessage(error));
  }
}

export function registerFetchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web-fetch",
    label: "Fetch Web Page Locally",
    ...webRenderers("web-fetch"),
    description:
      "Read one public HTTP(S) URL directly, without a hosted provider. HTML becomes readable Markdown; text, Markdown and JSON are returned directly. No JavaScript, cookies or credentials. Every redirect and DNS answer is validated and connections are pinned. Downloads are limited to 5 MiB and 30 seconds by default. Inline output is limited to 16KB or 400 lines, with complete extracted content saved to a temp file when truncated; use read for more. Never falls back to hosted fetching.",
    promptSnippet:
      "Read a public URL locally as Markdown or text, without sending it to a hosted provider.",
    promptGuidelines: [
      "Use web-fetch to read selected known URLs; do not re-fetch content already available unless freshness matters.",
      "web-fetch does not execute JavaScript or use a hosted fallback. Only explicitly call web-fetch-hosted, when available, if sending that public URL to a third party is appropriate.",
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
            "End-to-end timeout in milliseconds. Default 30000; maximum 120000.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const result = await fetchLocal(params.url, {
        timeout: params.timeout,
        signal,
      });
      const output = await boundedOutput(
        `Source: ${result.details.url}\nProvider: local${result.details.title ? `\nTitle: ${result.details.title}` : ""}\n\n${result.text}`,
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
