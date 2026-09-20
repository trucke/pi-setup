import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import {
  readPublicHttp,
  resolvePublicUrl,
  type ResolveHost,
} from "../shared/public-http.ts";
import { isPublicIpAddress, parsePublicHttpUrl } from "../shared/public-url.ts";
import { fetchLocal } from "./fetch.ts";

const PUBLIC = { address: "93.184.216.34", family: 4 };
const PRIVATE = { address: "10.0.0.1", family: 4 };

/**
 * Serves `handler` on localhost. Only the socket is redirected there:
 * production validation, DNS pinning, streaming and cancellation still run
 * against the public-looking URL.
 */
async function fixture(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  resolve: ResolveHost = async () => [PUBLIC],
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const redirected = ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    calls.push({ url: url.href, options });
    return request(
      new URL(
        `${url.pathname}${url.search}`,
        `http://127.0.0.1:${address.port}`,
      ),
      options,
      callback,
    );
  }) as typeof request;
  return { calls, transport: { resolve, request: redirected } };
}

test("rejects unsafe URL forms, reserved addresses and mixed DNS answers before any request", async () => {
  for (const input of [
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://localhost",
    "http://0x7f000001",
    "http://[::ffff:127.0.0.1]",
    "http://metadata.google.internal",
  ])
    assert.throws(() => parsePublicHttpUrl(input), input);
  for (const ip of [
    "10.0.0.1",
    "100.100.100.200",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "64:ff9b::a00:1",
  ])
    assert.equal(isPublicIpAddress(ip), false, ip);
  await assert.rejects(
    resolvePublicUrl(
      new URL("https://public.example"),
      new AbortController().signal,
      async () => [PUBLIC, PRIVATE],
    ),
    /non-public/,
  );
});

test("follows validated redirects on connections pinned to the approved address, and extracts HTML", async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/docs/guide" });
      return res.end();
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<html><head><title>Guide</title></head><body><nav>Navigation</nav><main><h1>Guide</h1><p>${"Useful article explanation. ".repeat(30)}<a href="next">Next</a><a href="javascript:alert(1)">Unsafe</a></p><pre><code>const answer = 42;</code></pre><script>throw new Error('executed')</script></main></body></html>`,
    );
  });
  const result = await fetchLocal(
    "http://public.example/start",
    {},
    f.transport,
  );
  assert.equal(result.details.url, "http://public.example/docs/guide");
  assert.match(result.text, /\[Next\]\(http:\/\/public.example\/docs\/next\)/);
  assert.match(result.text, /const answer = 42/);
  assert.doesNotMatch(result.text, /javascript:|executed/);

  assert.equal(f.calls.length, 2);
  for (const { options } of f.calls) {
    assert.equal(options.agent, false);
    // The socket may only connect to the validated answer, never re-resolve.
    const pinned = await new Promise((resolve, reject) =>
      options.lookup!(
        "public.example",
        { family: 0, hints: 0, all: false },
        (error, address) => (error ? reject(error) : resolve(address)),
      ),
    );
    assert.equal(pinned, PUBLIC.address);
  }
});

test("blocks private redirects, DNS rebinding and redirect loops without draining bodies", async (t) => {
  for (const [destination, requests, reason] of [
    ["http://127.0.0.1/secret", 1, /not public/],
    ["http://private.example/secret", 1, /non-public/],
    ["/loop", 6, /5 redirects/],
  ] as const) {
    const f = await fixture(
      t,
      (_req, res) => {
        res.writeHead(302, { Location: destination });
        res.flushHeaders(); // The body never ends.
      },
      async (host) => [host === "private.example" ? PRIVATE : PUBLIC],
    );
    await assert.rejects(
      fetchLocal("http://public.example/start", { timeout: 500 }, f.transport),
      reason,
    );
    assert.equal(f.calls.length, requests);
  }

  let lookups = 0;
  const rebinding = await fixture(
    t,
    (_req, res) => {
      res.writeHead(302, { Location: "/next" });
      res.end();
    },
    async () => [++lookups === 1 ? PUBLIC : PRIVATE],
  );
  await assert.rejects(
    fetchLocal("http://public.example", {}, rebinding.transport),
    /non-public/,
  );
  assert.equal(rebinding.calls.length, 1);
});

test("bounds declared and streamed bodies and rejects compressed responses", async (t) => {
  for (const [mode, reason] of [
    ["length", /exceeds/],
    ["chunks", /exceeds/],
    ["encoding", /encoding/],
  ] as const) {
    const f = await fixture(t, (_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      if (mode === "length") res.setHeader("Content-Length", "10000");
      if (mode === "encoding") res.setHeader("Content-Encoding", "gzip");
      // write() before end() keeps the body chunked, without a declared length.
      res.write("x".repeat(100));
      res.end();
    });
    await assert.rejects(
      readPublicHttp("http://public.example", {
        ...f.transport,
        signal: AbortSignal.timeout(1000),
        maxBytes: 64,
        accept: "text/plain",
      }),
      reason,
    );
  }
});

test("timeout and cancellation end stalled bodies and stalled DNS", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  });
  await assert.rejects(
    fetchLocal("http://public.example", { timeout: 30 }, f.transport),
    /timed out/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(
    fetchLocal(
      "http://public.example",
      { signal: controller.signal },
      f.transport,
    ),
    /cancelled/,
  );
  await assert.rejects(
    fetchLocal(
      "http://public.example",
      { timeout: 20 },
      { ...f.transport, resolve: () => new Promise(() => {}) },
    ),
    /timed out/,
  );
});
