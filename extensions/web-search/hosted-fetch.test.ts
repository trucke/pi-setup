import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { fetchHosted, normalizeHostedPage } from "./hosted-fetch.ts";
import type { HostedCall } from "./mcp.ts";

test("hosted fetch is registered only when PI_WEB_HOSTED_FETCH=1", (t) => {
  const original = process.env.PI_WEB_HOSTED_FETCH;
  t.after(() => {
    if (original === undefined) delete process.env.PI_WEB_HOSTED_FETCH;
    else process.env.PI_WEB_HOSTED_FETCH = original;
  });
  for (const value of [undefined, "true", "1"]) {
    if (value === undefined) delete process.env.PI_WEB_HOSTED_FETCH;
    else process.env.PI_WEB_HOSTED_FETCH = value;
    const tools: string[] = [];
    extension({
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      on() {},
      events: { on: () => () => {} },
    } as unknown as ExtensionAPI);
    assert.equal(tools.includes("web-fetch"), true);
    assert.equal(tools.includes("web-fetch-hosted"), value === "1");
  }
});

test("private destinations are rejected before any provider sees the URL", async () => {
  const calls: HostedCall[] = [];
  const call = async (input: HostedCall) => {
    calls.push(input);
    return "page";
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    fetchHosted(call, { url: "http://127.0.0.1/private" }, signal),
  );
  await assert.rejects(
    fetchHosted(call, { url: "http://private.example" }, signal, async () => [
      { address: "10.0.0.1", family: 4 },
    ]),
  );
  assert.equal(calls.length, 0);

  await fetchHosted(call, { url: "https://example.com" }, signal, async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.deepEqual(
    calls.map(({ provider, tool, args }) => ({ provider, tool, args })),
    [
      {
        provider: "exa",
        tool: "web_fetch_exa",
        args: { urls: ["https://example.com/"], maxCharacters: 100_000 },
      },
    ],
  );
});

test("Firecrawl JSON envelopes yield Markdown with selected metadata; other formats stay visible", () => {
  const document = {
    markdown: "# Example\n\nReadable **content**.",
    metadata: {
      title: "Example",
      sourceURL: "https://example.com",
      scrapeId: "private-id",
    },
  };
  for (const response of [document, { success: true, data: document }])
    assert.deepEqual(
      normalizeHostedPage("firecrawl", JSON.stringify(response)),
      {
        text: document.markdown,
        details: { title: "Example", url: "https://example.com" },
      },
    );
  assert.equal(
    normalizeHostedPage("firecrawl", '{"other":"evidence"}').text,
    '{"other":"evidence"}',
  );
});
