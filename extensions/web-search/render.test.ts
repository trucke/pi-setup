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
  summaryLine,
} from "./render.ts";

test("normalizes search result groups and keeps excerpt structure", () => {
  const items = searchItems({
    web: [
      {
        title: "Firecrawl",
        url: "https://www.firecrawl.dev/",
        description: "**Search**, scrape,\nand crawl",
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
      description: "**Search**, scrape,\nand crawl",
    },
    {
      kind: "news",
      title: "Release",
      url: "https://example.com/release",
      description: "A new release",
    },
  ]);
});

test("normalizes exa search details into the shared item view", () => {
  const items = searchItems({
    backend: "exa",
    results: [
      {
        title: "Exa result",
        url: "https://example.com/exa",
        publishedDate: "2026-08-01T00:00:00.000Z",
        snippet: "A relevant highlight",
      },
      { title: "", url: "https://example.com/untitled", snippet: "" },
    ],
  });

  assert.deepEqual(items, [
    {
      kind: "web",
      title: "Exa result",
      url: "https://example.com/exa",
      description: "A relevant highlight",
    },
    {
      kind: "web",
      title: "https://example.com/untitled",
      url: "https://example.com/untitled",
      description: "",
    },
  ]);

  const text = searchResultText({
    backend: "exa",
    results: [
      {
        title: "Exa result",
        url: "https://example.com/exa",
        snippet: "A relevant highlight",
      },
    ],
  });
  assert.match(text, /1\. \[web\] Exa result/);
  assert.match(text, /URL: https:\/\/example\.com\/exa/);
  assert.match(text, /   A relevant highlight/);
});

test("strips terminal control sequences from every rendered view", () => {
  const [item] = searchItems({
    web: [
      {
        title: "Evil\u001b[31m red\u0007 title",
        url: "https://example.com/\u001b[2Ja",
        description: "safe \u001b]0;owned\u0007text",
      },
    ],
  });
  assert.equal(item.title, "Evil red title");
  assert.equal(item.url, "https://example.com/a");
  assert.equal(item.description, "safe text");

  const document = documentView({
    markdown: "# Head\u001b[2Jing\nBody",
    metadata: {
      title: "Doc\u0007ument",
      sourceURL: "https://example.com/doc",
    },
  });
  assert.equal(document.title, "Document");
  assert.equal(document.markdown, "# Heading\nBody");

  const crawl = crawlView({
    status: "completed\u001b[31m",
    data: [],
  });
  assert.equal(crawl.status, "completed");
});

test("keeps defensive image descriptions compact", () => {
  const text = searchResultText({
    images: [
      {
        title: "Diagram",
        url: "https://example.com/diagram",
        description: `Line one\n${"x".repeat(600)}`,
      },
    ],
  });

  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[2].length, 503);
  assert.match(lines[2], /Line one x+…$/);
});

test("formats model-facing search results with bounded multi-line excerpts", () => {
  const text = searchResultText({
    web: [
      {
        title: "Official documentation",
        url: "https://example.com/docs",
        description: `**Highlight** line one\n${"x".repeat(2_500)}`,
        markdown: "This must not be included",
      },
      {
        title: "Line-heavy result",
        url: "https://example.com/lines",
        description: Array.from(
          { length: 150 },
          (_, index) => `line-${index.toString().padStart(4, "0")}`,
        ).join("\n"),
      },
      {
        title: "Final result",
        url: "https://example.com/final",
        description: "Still present",
      },
    ],
  });

  assert.match(text, /1\. \[web\] Official documentation/);
  assert.match(text, /URL: https:\/\/example\.com\/docs/);
  assert.match(text, /   \*\*Highlight\*\* line one\n/);
  const firstResult = text.split("\n\n2. ")[0];
  assert.ok(firstResult.length < 2_200);
  assert.doesNotMatch(text, /This must not be included/);
  assert.match(text, /2\. \[web\] Line-heavy result/);
  assert.match(text, /line-0099/);
  assert.doesNotMatch(text, /line-0100/);
  assert.match(text, /3\. \[web\] Final result/);
  assert.match(text, /   Still present/);
});

test("collapses excerpts to one bounded line for compact TUI rows", () => {
  assert.equal(summaryLine("A  multi-line\nexcerpt"), "A multi-line excerpt");
  const clipped = summaryLine("y".repeat(300));
  assert.equal(clipped.length, 200);
  assert.ok(clipped.endsWith("…"));
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
