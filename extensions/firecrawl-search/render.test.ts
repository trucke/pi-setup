import assert from "node:assert/strict";
import test from "node:test";
import {
  crawlMarkdown,
  crawlView,
  displayUrl,
  documentView,
  searchItems,
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
});

test("shortens URLs for compact tool rows", () => {
  assert.equal(
    displayUrl("https://docs.firecrawl.dev/api-reference/introduction?q=1"),
    "docs.firecrawl.dev/api-reference/introduction",
  );
});
