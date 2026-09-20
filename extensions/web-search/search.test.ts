import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { normalizeSearchResults } from "./search-results.ts";
import { registerSearchTool } from "./search.ts";

const result = {
  title: "Node HTTP",
  url: "https://nodejs.org/api/http.html",
  publishedDate: "2026-01-01",
  highlights: ["Relevant excerpt"],
  text: "UNWANTED FULL PAGE ".repeat(3000),
};

test("the search tool returns cited excerpts, not provider envelopes or full pages, from a single provider call", async () => {
  let tool: ToolDefinition<TSchema, unknown, unknown> | undefined;
  const providers: string[] = [];
  registerSearchTool(
    {
      registerTool: (value: typeof tool) => {
        tool = value;
      },
    } as unknown as ExtensionAPI,
    async (call) => {
      providers.push(call.provider);
      // Excerpts are bounded at the provider, not only after download.
      assert.equal(call.args.textMaxCharacters, 1200);
      return JSON.stringify({
        results: [result, result],
        requestId: "private-metadata",
      });
    },
  );
  assert.ok(tool);
  const output = await tool.execute(
    "test",
    { query: "Node HTTP", includeDomains: ["nodejs.org"], limit: 1 },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  const [content] = output.content;
  assert.ok(content.type === "text");
  assert.match(
    content.text,
    /^Provider: exa \(anonymous MCP\)\n\nResults: 1\n\n1\. Node HTTP\nhttps:\/\/nodejs.org\/api\/http.html\nPublished: 2026-01-01\nRelevant excerpt$/,
  );
  assert.deepEqual(output.details, {
    provider: "exa",
    resultCount: 1,
    items: [{ title: result.title, url: result.url }],
  });
  assert.deepEqual(providers, ["exa"]);
});

test("Exa labeled text keeps every source URL and bounds each excerpt", () => {
  const block = `Title: ${result.title}\nURL: ${result.url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n${"x".repeat(4000)}`;
  const normalized = normalizeSearchResults(`${block}\n\n${block}`, 2);
  assert.equal(normalized.resultCount, 2);
  assert.equal(normalized.text.match(/https:\/\/nodejs.org/g)?.length, 2);
  assert.equal(normalized.text.match(/Excerpt truncated/g)?.length, 2);
  assert.doesNotMatch(normalized.text, /N\/A|Author:/);
  assert.ok(normalized.text.length < 3000);
});

test("Firecrawl envelopes normalize to the same cited, bounded shape", () => {
  const normalized = normalizeSearchResults(
    JSON.stringify({
      success: true,
      data: {
        web: [
          {
            title: result.title,
            url: result.url,
            description: "x".repeat(5000),
          },
        ],
      },
      creditsUsed: 2,
    }),
    5,
  );
  assert.equal(normalized.resultCount, 1);
  assert.match(normalized.text, /^1\. Node HTTP\nhttps:\/\/nodejs.org/);
  assert.match(normalized.text, /Excerpt truncated/);
  assert.ok(normalized.text.length < 1500);
});

test("unfamiliar formats stay visible as evidence and empty results are reported as such", () => {
  assert.equal(
    normalizeSearchResults("Different upstream format", 5).text,
    "Different upstream format",
  );
  assert.deepEqual(normalizeSearchResults('{"data":{"web":[]}}', 5), {
    text: "No search results returned.",
    resultCount: 0,
    items: [],
  });
});
