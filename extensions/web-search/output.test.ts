import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { boundedOutput } from "./output.ts";

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
