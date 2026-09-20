import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parsePublicHttpUrl } from "../shared/public-url.ts";
import { resolvePublicUrl, type ResolveHost } from "../shared/public-http.ts";
import {
  withHostedFallback,
  type CallHosted,
  type HostedProvider,
} from "./mcp.ts";
import { boundedOutput } from "./output.ts";
import { webRenderers } from "./render.ts";
import { sanitizeLine } from "./sanitize.ts";

export function normalizeHostedPage(provider: HostedProvider, text: string) {
  const details: { title?: string; url?: string } = {};
  if (provider !== "firecrawl") return { text, details };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return { text, details };
    const page = "data" in parsed ? parsed.data : parsed;
    if (
      typeof page !== "object" ||
      page === null ||
      !("markdown" in page) ||
      typeof page.markdown !== "string"
    )
      return { text, details };
    if (
      "metadata" in page &&
      typeof page.metadata === "object" &&
      page.metadata !== null
    ) {
      const metadata = page.metadata;
      if ("title" in metadata && typeof metadata.title === "string")
        details.title = sanitizeLine(metadata.title).slice(0, 300);
      if ("sourceURL" in metadata && typeof metadata.sourceURL === "string")
        details.url = sanitizeLine(metadata.sourceURL).slice(0, 8192);
    }
    return { text: page.markdown, details };
  } catch {
    // Preserve unfamiliar formats as evidence, still under the inline budget.
    return { text, details };
  }
}

export async function fetchHosted(
  call: CallHosted,
  params: { url: string; provider?: HostedProvider },
  signal: AbortSignal = new AbortController().signal,
  resolve?: ResolveHost,
) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const url = parsePublicHttpUrl(params.url);
  // Fail closed before disclosing even the URL. Redirect handling after this
  // point belongs to the hosted service, unlike the locally pinned fetch tool.
  await resolvePublicUrl(url, combined, resolve);
  return withHostedFallback(
    (provider) =>
      call({
        provider,
        tool: provider === "exa" ? "web_fetch_exa" : "firecrawl_scrape",
        args:
          provider === "exa"
            ? { urls: [url.href], maxCharacters: 100_000 }
            : { url: url.href, formats: ["markdown"], onlyMainContent: true },
        signal: combined,
      }),
    combined,
    params.provider,
  );
}

export function registerHostedFetchTool(pi: ExtensionAPI, call: CallHosted) {
  pi.registerTool({
    name: "web-fetch-hosted",
    label: "Fetch Web Page via Hosted Provider",
    ...webRenderers("web-fetch-hosted"),
    description:
      "Explicitly send a public URL to anonymous hosted MCP extraction. Exa first; Firecrawl scrape is used only after transient failures, rate limits or unavailable pages. May return cached content. Hosted services own redirect and browser behavior. This tool is separate from local web-fetch and is never called automatically by it. Inline output is limited to 16KB or 400 lines, with complete returned content saved to a temp file when truncated; use read for more.",
    promptSnippet:
      "Explicit third-party extraction of a public page, when local fetching is insufficient.",
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: "Public URL to send to the hosted provider.",
      }),
      provider: Type.Optional(
        StringEnum(["exa", "firecrawl"] as const, {
          description:
            "Explicit provider for a targeted retry; disables automatic fallback.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const result = await fetchHosted(call, params, signal);
      const { text, ...details } = result;
      const page = normalizeHostedPage(result.provider, text);
      const output = await boundedOutput(
        `Provider: ${result.provider} (anonymous MCP)${result.fallbackReason ? `\nFallback: ${result.fallbackReason}` : ""}\n\n${page.text || "No page content returned."}`,
        "web-fetch-hosted",
      );
      return {
        content: [{ type: "text", text: output.text }],
        details: {
          ...details,
          ...page.details,
          contentBytes: Buffer.byteLength(page.text),
          ...output.details,
        },
      };
    },
  });
}
