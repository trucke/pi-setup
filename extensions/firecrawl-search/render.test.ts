import assert from "node:assert/strict";
import test from "node:test";
import {
  crawlMarkdown,
  crawlResultText,
  crawlView,
  displayUrl,
  documentView,
  searchItems,
  searchResultText,
} from "./render.ts";

test("normalizes search result groups", () => {
  const items = searchItems({
    web: [
      {
        title: "Firecrawl",
        url: "https://www.firecrawl.dev/",
        description: "Search, scrape,\n and crawl",
      },
    ],
    news: [
      {
        title: "Release",
        url: "https://example.com/release",
        snippet: "A new release",
      },
    ],
  });

  assert.deepEqual(items, [
    {
      kind: "web",
      title: "Firecrawl",
      url: "https://www.firecrawl.dev/",
      description: "Search, scrape, and crawl",
    },
    {
      kind: "news",
      title: "Release",
      url: "https://example.com/release",
      description: "A new release",
    },
  ]);
});

test("formats concise model-facing search results", () => {
  const text = searchResultText({
    web: [
      {
        title: "Official documentation",
        url: "https://example.com/docs",
        description: "x".repeat(600),
        markdown: "This must not be included",
      },
    ],
  });

  assert.match(text, /1\. \[web\] Official documentation/);
  assert.match(text, /URL: https:\/\/example\.com\/docs/);
  assert.ok(text.length < 600);
  assert.doesNotMatch(text, /This must not be included/);
});

test("extracts only useful document metadata", () => {
  assert.deepEqual(
    documentView({
      markdown: "# Introduction",
      metadata: {
        title: "Introduction",
        sourceURL: "https://docs.example.com/introduction",
        description: "API docs",
        statusCode: 200,
        creditsUsed: 1,
        ogImage: "https://example.com/very-long-image-url",
      },
    }),
    {
      title: "Introduction",
      url: "https://docs.example.com/introduction",
      description: "API docs",
      markdown: "# Introduction",
      statusCode: 200,
      creditsUsed: 1,
    },
  );
});

test("builds a readable crawl view and Markdown document", () => {
  const view = crawlView({
    id: "crawl-1",
    status: "completed",
    completed: 1,
    total: 1,
    creditsUsed: 1,
    data: [
      {
        markdown: "Page content",
        metadata: {
          title: "Page one",
          sourceURL: "https://example.com/page-one",
        },
      },
    ],
  });

  assert.equal(view.status, "completed");
  assert.equal(view.documents.length, 1);
  assert.match(crawlMarkdown(view.documents).content, /## 1\. Page one/);
  assert.match(
    crawlMarkdown(view.documents).content,
    /Source: https:\/\/example\.com\/page-one/,
  );

  const output = crawlResultText({
    id: "crawl-1",
    status: "completed",
    completed: 1,
    total: 1,
    creditsUsed: 1,
    data: [
      {
        markdown: "Page content",
        metadata: {
          title: "Page one",
          sourceURL: "https://example.com/page-one",
          ogImage: "https://example.com/image.png",
        },
      },
    ],
  });
  assert.match(output, /Crawl completed: 1\/1 pages · 1 credit/);
  assert.match(output, /Page content/);
  assert.doesNotMatch(output, /ogImage|image\.png/);
});

test("shortens URLs for compact tool rows", () => {
  assert.equal(
    displayUrl("https://docs.firecrawl.dev/api-reference/introduction?q=1"),
    "docs.firecrawl.dev/api-reference/introduction",
  );
});
