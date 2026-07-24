import assert from "node:assert/strict";
import test from "node:test";
import {
  countGitDiffLines,
  parseGitChangedPaths,
  parseJjChangedPaths,
  sanitizeTerminalText,
} from "./src/changed-files-view.ts";

test("parses Git changed paths including rename records", () => {
  assert.deepEqual(
    parseGitChangedPaths(" M one.ts\0R  new.ts\0old.ts\0?? two.ts\0"),
    [
      { path: "one.ts", status: " M" },
      { path: "new.ts", status: "R " },
      { path: "two.ts", status: "??" },
    ],
  );
});

test("parses JJ path and status pairs", () => {
  assert.deepEqual(parseJjChangedPaths("one.ts\0M\0two.ts\0A\0"), [
    { path: "one.ts", status: "M" },
    { path: "two.ts", status: "A" },
  ]);
});

test("counts additions and deletions in Git-format diffs", () => {
  assert.deepEqual(
    countGitDiffLines(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+next\n",
    ),
    { additions: 2, deletions: 1 },
  );
  assert.deepEqual(countGitDiffLines("Binary files a/a and b/a differ\n"), {
    additions: null,
    deletions: null,
  });
});

test("repository text cannot inject terminal control sequences", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTerminalText(input), "beforeafterred");
});
