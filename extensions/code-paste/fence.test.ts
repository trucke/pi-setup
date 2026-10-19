import assert from "node:assert/strict";
import test from "node:test";
import { codeBlock, codePaste, trimCode } from "./fence.ts";

test("trims surrounding blank lines but keeps indentation", () => {
  assert.equal(
    trimCode("\n  \n  if (x) {\n    y();\n  }\n\n"),
    "  if (x) {\n    y();\n  }",
  );
});

test("outgrows backtick runs inside the code", () => {
  assert.equal(codeBlock("a"), "```\na\n```");
  assert.equal(codeBlock("```ts\nx\n```"), "````\n```ts\nx\n```\n````");
});

test("separates the block from the draft before it", () => {
  assert.equal(codePaste("x", ""), "```\nx\n```\n\n");
  assert.equal(codePaste("x", "Why?"), "\n\n```\nx\n```\n\n");
  assert.equal(codePaste("x", "Why?\n"), "\n```\nx\n```\n\n");
  assert.equal(codePaste("x", "Why?\n\n"), "```\nx\n```\n\n");
});
