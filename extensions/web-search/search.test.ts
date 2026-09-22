import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { normalizeSearchResults } from "./search-results.ts";
import { registerSearchTool } from "./search.ts";

const source = { title: "Node HTTP", url: "https://nodejs.org/api/http.html" };

test("search makes one provider call and returns limited cited excerpts, not full pages", async () => {
  let tool: ToolDefinition<TSchema, unknown, unknown> | undefined;
  let calls = 0;
  registerSearchTool(
    {
      registerTool: (value: typeof tool) => {
        tool = value;
      },
    } as unknown as ExtensionAPI,
    async (call) => {
      calls++;
      assert.equal(call.args.textMaxCharacters, 1200);
      const result = {
        ...source,
        highlights: ["Relevant excerpt"],
        text: "UNWANTED FULL PAGE ".repeat(3000),
      };
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
    /https:\/\/nodejs.org\/api\/http.html\nRelevant excerpt/,
  );
  assert.doesNotMatch(content.text, /UNWANTED|private-metadata/);
  assert.deepEqual(output.details, {
    provider: "exa",
    resultCount: 1,
    items: [source],
  });
  assert.equal(calls, 1);
});

test("Exa and Firecrawl formats retain citations and bound excerpts", () => {
  for (const input of [
    `Title: ${source.title}\nURL: ${source.url}\nHighlights:\n${"x".repeat(4000)}`,
    JSON.stringify({
      success: true,
      data: { web: [{ ...source, description: "x".repeat(4000) }] },
    }),
  ]) {
    const result = normalizeSearchResults(input, 5);
    assert.equal(result.resultCount, 1);
    assert.ok(result.text.includes(source.url));
    assert.match(result.text, /Excerpt truncated/);
    assert.ok(result.text.length < 1500);
  }
  assert.equal(
    normalizeSearchResults("Unfamiliar upstream format", 5).text,
    "Unfamiliar upstream format",
  );
  assert.equal(normalizeSearchResults('{"data":{"web":[]}}', 5).resultCount, 0);
});
