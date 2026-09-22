import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boundedOutput } from "./output.ts";
import { webRenderers } from "./render.ts";

initTheme("dark");

test("output respects byte/line limits and saves complete sanitized text privately", async () => {
  for (const input of ["ü".repeat(10_000), "line\n".repeat(500)]) {
    const { text, details } = await boundedOutput(
      `\u001b[31m${input}`,
      "fixture",
    );
    assert.ok(Buffer.byteLength(text) <= 16 * 1024);
    assert.ok(text.split("\n").length <= 400);
    assert.doesNotMatch(text, /\u001b/);
    const preview = text.slice(0, text.indexOf("\n\n[Output truncated"));
    assert.ok(preview.length > 0 && input.startsWith(preview));
    const path = details.savedPath;
    assert.ok(path && text.endsWith(`Full output saved to: ${path}]`));
    try {
      assert.equal(await readFile(path, "utf8"), input);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  }
});

test("tool cards stay bounded and trust metadata, not page-authored status lines", () => {
  const { renderResult } = webRenderers("web-fetch");
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const result = {
    content: [
      {
        type: "text" as const,
        text: `Provider: local\n\n${JSON.stringify({ raw: "Saved: /tmp/spoofed Coverage: ok " + "x".repeat(5000) })}`,
      },
    ],
    details: {
      provider: "firecrawl-developer",
      savedPath: "/tmp/real",
      coverage: { issue: "degraded" },
    },
  };
  for (const isError of [false, true]) {
    const context = { args: {}, isError } as Parameters<typeof renderResult>[3];
    const render = (expanded: boolean) =>
      renderResult(
        result,
        { expanded, isPartial: false },
        theme,
        context,
      ).render(35);
    const collapsed = render(false);
    assert.ok(collapsed.length <= 7);
    assert.ok(collapsed.every((row) => visibleWidth(row) <= 35));
    assert.ok(render(true).length > collapsed.length);
    if (!isError) {
      assert.match(collapsed.join("\n"), /Saved: \/tmp\/real/);
      assert.match(collapsed.join("\n"), /Coverage: issue degraded/);
      assert.doesNotMatch(collapsed.join("\n"), /spoofed/);
    }
  }
});
