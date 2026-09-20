import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { abortable, readResponseText } from "../shared/public-http.ts";
import { sanitizeLine, sanitizeText } from "./sanitize.ts";

export type HostedProvider = "exa" | "firecrawl";
export const MCP_URLS = {
  exa: "https://mcp.exa.ai/mcp",
  firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
} as const;
export type FailureKind =
  | "transient"
  | "rate-limit"
  | "unavailable"
  | "auth"
  | "billing"
  | "validation"
  | "unsafe"
  | "cancelled"
  | "protocol";
export class HostedError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Unknown failures are deliberately not retryable. Auth/billing always wins. */
export function providerFailure(message: string, status?: number): HostedError {
  const text = sanitizeLine(message).slice(0, 500);
  // Some MCP tools wrap upstream HTTP failures in an isError text block.
  const reportedStatus = text.match(
    /\b(?:HTTP|status(?:\s*code)?)[\s:"=]+([45]\d\d)\b/i,
  )?.[1];
  status ??= reportedStatus ? Number(reportedStatus) : undefined;
  let kind: FailureKind = "protocol";
  if (status === 402) kind = "billing";
  else if (status === 401 || status === 403) kind = "auth";
  else if (
    /insufficient.*credit|credit.*(?:exhaust|balance)|payment required|billing (?:error|limit)|quota.*exhaust/i.test(
      text,
    )
  )
    kind = "billing";
  else if (
    /invalid api.?key|unauthori[sz]ed|authentication (?:failed|required)|forbidden/i.test(
      text,
    )
  )
    kind = "auth";
  else if (
    /unsafe|private.*(?:url|address)|blocked.*(?:url|address)|ssrf/i.test(text)
  )
    kind = "unsafe";
  else if (
    /invalid.*(?:argument|param|url)|validation/i.test(text) ||
    status === 400 ||
    status === 422
  )
    kind = "validation";
  else if (status === 429 || /rate.?limit|too many requests/i.test(text))
    kind = "rate-limit";
  else if (
    status === 404 ||
    status === 410 ||
    /page (?:not found|unavailable)|unable to (?:fetch|retrieve)|could not (?:fetch|retrieve)/i.test(
      text,
    )
  )
    kind = "unavailable";
  else if (
    (status !== undefined && [408, 500, 502, 503, 504].includes(status)) ||
    /timed? ?out|temporarily unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(
      text,
    )
  )
    kind = "transient";
  return new HostedError(kind, text || `HTTP ${status ?? "failure"}`);
}

export interface HostedCall {
  provider: HostedProvider;
  tool: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}
export type CallHosted = (call: HostedCall) => Promise<string>;

/** Pass SSE through immediately; a valid result does not require stream EOF. */
function boundedResponse(
  response: Response,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
) {
  const maxBytes = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new HostedError("protocol", `Response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  let finished = false;
  let onAbort = () => {};
  const stop = (reason?: unknown) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    void reader.cancel(reason).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (finished) return;
        controller.error(signal.reason);
        stop(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          signal.removeEventListener("abort", onAbort);
          reader.releaseLock();
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if (bytes > maxBytes)
          throw new HostedError(
            "protocol",
            `Response exceeds ${maxBytes} bytes.`,
          );
        controller.enqueue(value);
      } catch (error) {
        if (finished) return;
        controller.error(error);
        stop(error);
        onFailure(error);
      }
    },
    cancel: stop,
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Isolated transport boundary. Anonymous by default, with no OAuth provider,
 * credential-store access or authentication retry. OAuth and API keys are deferred.
 */
export function createMcpCaller(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): CallHosted {
  const doFetch = options.fetch ?? fetch;
  return async ({ provider, tool, args, signal }) => {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const lifecycle = new AbortController();
    const combined = AbortSignal.any([signal, timeout, lifecycle.signal]);
    let transportFailure: unknown;
    const client = new Client({ name: "pi-web-tools", version: "1.0.0" });
    // The SDK reports SSE parse errors out-of-band. Do not let an invalid
    // response linger until our deadline and masquerade as a retryable timeout.
    client.onerror = (error) => {
      if (combined.aborted) return;
      transportFailure ??=
        error instanceof HostedError ? error : providerFailure(error.message);
      lifecycle.abort(error);
    };
    const endpoint = new URL(MCP_URLS[provider]);
    if (provider === "exa" && tool === "web_search_advanced_exa")
      endpoint.searchParams.set(
        "tools",
        "web_search_exa,web_fetch_exa,web_search_advanced_exa",
      );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: async (url, init) => {
        // We only make bounded request/response calls, not an idle notification stream.
        if (init?.method === "GET") return new Response(null, { status: 405 });
        try {
          const requestSignal = init?.signal
            ? AbortSignal.any([combined, init.signal])
            : combined;
          const response = await doFetch(url, {
            ...init,
            redirect: "manual",
            signal: requestSignal,
          });
          if (!response.ok) {
            const statusFailure = providerFailure("", response.status);
            // Never let a slow/malformed error body turn a terminal status into
            // a transient timeout and disclose the request to another provider.
            if (
              !["transient", "rate-limit", "unavailable"].includes(
                statusFailure.kind,
              )
            ) {
              void response.body?.cancel().catch(() => {});
              throw statusFailure;
            }
            let text: string;
            try {
              text = await readResponseText(response, requestSignal, 16 * 1024);
            } catch {
              throw statusFailure;
            }
            throw providerFailure(text, response.status);
          }
          return boundedResponse(response, requestSignal, (error) => {
            transportFailure = error;
            lifecycle.abort(error);
          });
        } catch (error) {
          transportFailure = error;
          throw error;
        }
      },
    });
    try {
      await abortable(client.connect(transport), combined);
      const result = await abortable(
        client.callTool({ name: tool, arguments: args }, undefined, {
          signal: combined,
        }),
        combined,
      );
      const content = result.content;
      const text = Array.isArray(content)
        ? content
            .flatMap((item: unknown) => {
              if (
                typeof item !== "object" ||
                item === null ||
                !("type" in item) ||
                item.type !== "text" ||
                !("text" in item) ||
                typeof item.text !== "string"
              )
                return [];
              return [item.text];
            })
            .join("\n\n")
        : "";
      if (result.isError) throw providerFailure(text);
      // Firecrawl also reports failures inside JSON text without isError.
      try {
        const data: unknown = JSON.parse(text);
        if (
          typeof data === "object" &&
          data !== null &&
          "success" in data &&
          data.success === false
        ) {
          throw providerFailure(text);
        }
      } catch (error) {
        if (error instanceof HostedError) throw error;
      }
      return sanitizeText(text);
    } catch (error) {
      if (signal.aborted)
        throw new HostedError("cancelled", "Hosted web request cancelled.");
      const failure = transportFailure ?? error;
      if (failure instanceof HostedError) throw failure;
      if (timeout.aborted)
        throw new HostedError(
          "transient",
          `${provider} MCP request timed out.`,
        );
      throw providerFailure(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      lifecycle.abort();
      await client.close().catch(() => {});
    }
  };
}

export async function withHostedFallback(
  operation: (provider: HostedProvider) => Promise<string>,
  signal: AbortSignal,
  provider?: HostedProvider,
) {
  signal.throwIfAborted();
  try {
    return {
      provider: provider ?? "exa",
      text: await operation(provider ?? "exa"),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      provider ||
      !(error instanceof HostedError) ||
      !["transient", "rate-limit", "unavailable"].includes(error.kind)
    )
      throw error;
    const fallbackReason = `Exa ${error.kind}: ${error.message}`;
    try {
      return {
        provider: "firecrawl" as const,
        text: await operation("firecrawl"),
        fallbackReason,
      };
    } catch (secondary) {
      throw new Error(
        `${fallbackReason}; Firecrawl fallback failed: ${secondary instanceof Error ? secondary.message : String(secondary)}`,
      );
    }
  }
}
