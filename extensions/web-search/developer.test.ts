import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEVELOPER_SEARCH_URL,
  developerSearchDetails,
  developerSearchResultText,
  registerDeveloperSearchTool,
  type DeveloperSearchToolDependencies,
} from "./developer.ts";

const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
interface Tool {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ text: string }>;
    details: { resultCount: number; auth: string };
  }>;
}
function developerTool(
  fetchMock: typeof fetch,
  dependencies: Partial<DeveloperSearchToolDependencies> = {},
) {
  let tool: Tool | undefined;
  registerDeveloperSearchTool(
    {
      registerTool: (value: Tool) => {
        tool = value;
      },
    } as unknown as ExtensionAPI,
    {
      getApiKey: () => undefined,
      ...dependencies,
      transport: { fetch: fetchMock, ...dependencies.transport },
    },
  );
  assert.ok(tool);
  return tool;
}

test("developer search supports optional authentication and validates before dispatch", async () => {
  for (const apiKey of [undefined, "fc-key"]) {
    let requests = 0;
    const tool = developerTool(
      async (url, init) => {
        requests++;
        assert.equal(String(url), DEVELOPER_SEARCH_URL);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          apiKey ? `Bearer ${apiKey}` : null,
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          query: "hydration",
          k: 10,
          types: ["issue"],
        });
        return Response.json({
          results: [
            {
              type: "issue",
              url: "https://github.com/a/b/issues/1",
              passages: [{ text: "Relevant **passage**" }],
            },
          ],
        });
      },
      { getApiKey: () => apiKey },
    );
    await assert.rejects(
      tool.execute("invalid", { query: "q", types: ["doc"], repos: ["a/b"] }),
    );
    await assert.rejects(
      tool.execute("cancelled", { query: "q" }, AbortSignal.abort()),
    );
    assert.equal(requests, 0);
    const result = await tool.execute("sent", {
      query: "hydration",
      types: ["issue"],
    });
    assert.equal(requests, 1);
    assert.equal(result.details.auth, apiKey ? "account" : "anonymous");
    assert.match(result.content[0].text, /Relevant \*\*passage\*\*/);
  }
});

test("request failures redact API keys, enforce deadlines and propagate cancellation", async () => {
  const tool = developerTool(
    async () =>
      new Response("rate limited for fc-key\u001b[31m", { status: 429 }),
    { getApiKey: () => "fc-key" },
  );
  await assert.rejects(tool.execute("call", { query: "q" }), (error: Error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /fc-key|\u001b/);
    return true;
  });
  let transportSignal: AbortSignal | null | undefined;
  const stalled: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      transportSignal = init?.signal;
      transportSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  await assert.rejects(
    developerTool(stalled, { transport: { timeoutMs: 20 } }).execute(
      "timeout",
      { query: "q" },
    ),
    /timed out/,
  );
  const controller = new AbortController();
  const pending = developerTool(stalled).execute(
    "cancel",
    { query: "q" },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(transportSignal?.aborted, true);
});

test("provider results preserve useful passages and honest coverage without unsafe terminal text", () => {
  const details = developerSearchDetails({
    results: [
      {
        id: "pull_request:react/react#1",
        url: "https://github.com/react/react/issues/1",
        passages: [
          { text: "**Relevant**\u001b[31m" },
          { text: "x".repeat(5000) },
        ],
      },
      { title: "No URL is dropped" },
    ],
    coverage: { doc: "ok", issue: "degraded\u001b[31m" },
    repos: [
      { repo: "facebook/react", canonicalRepo: "react/react", indexed: true },
    ],
  });
  assert.equal(details.results.length, 1);
  assert.equal(details.results[0].type, "pull_request");
  assert.equal(details.results[0].passages[1].length, 2000);
  const text = developerSearchResultText(details);
  assert.match(text, /\*\*Relevant\*\*/);
  assert.match(text, /issue degraded/);
  assert.match(text, /facebook\/react → react\/react/);
  assert.doesNotMatch(text, /\u001b/);
  assert.match(
    developerSearchResultText(developerSearchDetails({ results: [] })),
    /Coverage: not reported/,
  );
});
