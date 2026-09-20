import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { parsePublicHttpUrl, validateResolvedAddresses } from "./public-url.ts";

/** Stop waiting on non-cancellable work (notably DNS), without leaking listeners. */
export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The promise was created by the caller before we could inspect the signal.
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export type ResolveHost = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;
const resolveHost: ResolveHost = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicUrl(
  url: URL,
  signal: AbortSignal,
  resolve: ResolveHost = resolveHost,
) {
  parsePublicHttpUrl(url.href);
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await abortable(resolve(hostname), signal);
  signal.throwIfAborted();
  // Reject mixed public/private answers rather than silently picking a public one.
  validateResolvedAddresses(addresses.map(({ address }) => address));
  return addresses[0];
}

export interface PublicHttpOptions {
  signal: AbortSignal;
  maxBytes: number;
  accept: string;
  /** Dependency injection for fixture tests, never exposed as tool parameters. */
  resolve?: ResolveHost;
  request?: typeof httpRequest;
}

/** Direct connections only: no proxy, cookies, credentials or second DNS lookup. */
export async function readPublicHttp(
  input: string,
  options: PublicHttpOptions,
) {
  const { signal, maxBytes } = options;
  let url = parsePublicHttpUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const pinned = await resolvePublicUrl(url, signal, options.resolve);
    const pinnedLookup: LookupFunction = (_hostname, opts, callback) => {
      // Node can request all addresses when autoSelectFamily is enabled.
      if (opts.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (
        options.request ??
        (url.protocol === "https:" ? httpsRequest : httpRequest)
      )(
        url,
        {
          signal,
          agent: false,
          lookup: pinnedLookup,
          headers: {
            Accept: options.accept,
            "Accept-Encoding": "identity",
            "User-Agent": "pi-web-fetch/1",
          },
        },
        resolve,
      );
      request.once("error", reject);
      request.end();
    });
    try {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        if (!location) throw new Error("Redirect has no Location header.");
        // Validate before even resolving the next destination.
        url = parsePublicHttpUrl(new URL(location, url).href);
        continue;
      }
      if (status < 200 || status >= 300)
        throw new Error(
          `HTTP ${status}. Local fetch did not use a hosted provider.`,
        );
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding.toLowerCase() !== "identity")
        throw new Error(`Unsupported content encoding: ${encoding}`);
      if (Number(response.headers["content-length"]) > maxBytes)
        throw new Error(`Response exceeds ${maxBytes} bytes.`);
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        signal.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes)
          throw new Error(`Response exceeds ${maxBytes} bytes.`);
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      return {
        url: url.href,
        contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
        bytes,
      };
    } finally {
      // Do not drain redirect/error bodies: they may be infinite or enormous.
      response.destroy();
    }
  }
  throw new Error("Fetch exceeded 5 redirects.");
}

/** Bounds provider response bodies before JSON parsing, including stalled streams. */
export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = 4 * 1024 * 1024,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new Error(`Response exceeds ${maxBytes} bytes.`);
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new Error(`Response exceeds ${maxBytes} bytes.`);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
