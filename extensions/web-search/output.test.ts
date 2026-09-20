import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { boundedOutput } from "./output.ts";

test("bounds bytes and lines including the notice, and keeps sanitized full text in a private file", async () => {
  for (const input of ["ü".repeat(10_000), "line\n".repeat(500)]) {
    const { text: output, details } = await boundedOutput(
      `\u001b[31m${input}`,
      "fixture",
    );
    assert.ok(Buffer.byteLength(output) <= 16 * 1024);
    assert.ok(output.split("\n").length <= 400);
    assert.doesNotMatch(output, /\u001b/);
    // A single over-budget line (minified JSON) still yields a preview, cut on
    // a character boundary rather than dropped or split mid-sequence.
    const preview = output.slice(0, output.indexOf("\n\n[Output truncated"));
    assert.ok(preview.length > 0 && input.startsWith(preview));
    if (!input.includes("\n")) assert.ok(Buffer.byteLength(output) > 15 * 1024);
    const path = details.savedPath;
    assert.ok(path);
    // The model-facing notice names the same file as the trusted metadata.
    assert.ok(output.endsWith(`Full output saved to: ${path}]`));
    try {
      assert.equal(await readFile(path, "utf8"), input);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  }
  assert.deepEqual(await boundedOutput("short", "fixture"), {
    text: "short",
    details: {},
  });
});
