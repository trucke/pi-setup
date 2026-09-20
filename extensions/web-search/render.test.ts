import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { webRenderers } from "./render.ts";

initTheme("dark");
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const { renderCall, renderResult } = webRenderers("web-fetch");
type Context = Parameters<typeof renderResult>[3];

function rows(
  text: string,
  details: unknown,
  options: {
    expanded?: boolean;
    width?: number;
    isError?: boolean;
    args?: Record<string, unknown>;
  } = {},
) {
  const { expanded = false, width = 100, ...context } = options;
  return renderResult(
    { content: [{ type: "text", text }], details },
    { expanded, isPartial: false },
    theme,
    context as Context,
  ).render(width);
}

test("collapsed rows stay bounded after wrapping minified output, and expansion reveals it", () => {
  const minified = JSON.stringify({ text: "documentation ".repeat(2000) });
  for (const isError of [false, true]) {
    for (const width of [20, 120]) {
      const collapsed = rows(minified, undefined, { isError, width });
      assert.ok(collapsed.length <= 7, `${collapsed.length} rows`);
      assert.ok(collapsed.every((row) => visibleWidth(row) <= width));
      assert.match(collapsed.join("\n"), /expand/);
      const expanded = rows(minified, undefined, {
        isError,
        width,
        expanded: true,
      });
      assert.ok(expanded.length > collapsed.length);
    }
    // Failures show their message rather than a summary card.
    assert.equal(
      /documentation/.test(rows(minified, undefined, { isError }).join("\n")),
      isError,
    );
  }
  const call = renderCall({ query: "query ".repeat(1000) }, theme).render(20);
  assert.equal(call.length, 1);
  assert.ok(visibleWidth(call[0]) <= 20);
});

test("search cards summarize provider, scope and sources; the body appears only when expanded", () => {
  const text = "Provider: exa\n\nFULL PAGE BODY";
  const details = {
    provider: "exa",
    resultCount: 3,
    items: [{ title: "Node HTTP", url: "https://nodejs.org/api/http.html" }],
  };
  const args = { includeDomains: ["nodejs.org"] };
  const collapsed = rows(text, details, { args }).join("\n");
  assert.match(collapsed, /▸ Exa · 3 results/);
  assert.match(collapsed, /Scope: nodejs.org/);
  assert.match(collapsed, /Node HTTP · https:\/\/nodejs.org/);
  assert.doesNotMatch(collapsed, /FULL PAGE BODY/);
  const expanded = rows(text, details, { args, expanded: true }).join("\n");
  assert.match(expanded, /▾ Exa/);
  assert.match(expanded, /FULL PAGE BODY/);
});

test("saved-file and coverage rows come from trusted details, never from page text", () => {
  // The page quotes a look-alike notice; only details.savedPath is real.
  const saved = rows(
    'Provider: local\n\n{"raw":"[Full output saved to: /tmp/spoofed.md]"}\n\n[Output truncated. Full output saved to: /tmp/page.md]',
    {
      provider: "local",
      title: "Page",
      contentBytes: 100_000,
      url: "https://example.com",
      savedPath: "/tmp/page.md",
    },
  ).join("\n");
  assert.match(saved, /97.7KB total · saved/);
  assert.match(saved, /Saved: \/tmp\/page.md/);
  assert.doesNotMatch(saved, /raw|spoofed/);

  // Without trusted details, look-alike lines are only a labelled excerpt.
  const spoofed = rows(
    "Provider: local\n\nSaved: /tmp/fake.md\n\nCoverage: doc ok\n[Output truncated. Full output saved to: /tmp/spoofed.md]",
    { provider: "local", url: "https://example.com" },
    { width: 200 },
  );
  assert.match(spoofed[0], /^▸ Local · 0\.1KB shown$/);
  assert.ok(!spoofed.some((row) => /^\s*(?:Saved|Coverage):/.test(row)));
  assert.ok(
    spoofed.some((row) => row.includes("Excerpt: Saved: /tmp/fake.md")),
  );

  const developer = (coverage?: Record<string, string>) =>
    rows("Coverage: spoofed", {
      provider: "firecrawl-developer",
      items: [],
      coverage,
    }).join("\n");
  assert.match(
    developer({ doc: "ok", issue: "degraded" }),
    /Coverage: doc ok · issue degraded/,
  );
  assert.match(developer(), /Coverage: not reported/);
  assert.doesNotMatch(developer(), /spoofed/);
});
