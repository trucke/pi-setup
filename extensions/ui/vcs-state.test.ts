import assert from "node:assert/strict";
import test from "node:test";
import { countGitChanges, countJjChanges, parseJjRevision } from "./vcs/vcs.ts";

test("parses a JJ working-copy change and its bookmarks", () => {
  assert.deepEqual(parseJjRevision("abcdefgh\0feature\0review\0"), {
    bookmarks: ["feature", "review"],
    changeId: "abcdefgh",
  });
  assert.deepEqual(parseJjRevision("abcdefgh\0\0"), {
    bookmarks: [],
    changeId: "abcdefgh",
  });
});

test("counts NUL-delimited JJ diff entries", () => {
  assert.equal(countJjChanges("one.ts\0M\0two.ts\0A\0"), 2);
  assert.equal(countJjChanges(""), 0);
});

test("counts Git porcelain entries and skips rename source paths", () => {
  assert.equal(countGitChanges(" M one.ts\0?? two.ts\0R  new.ts\0old.ts\0"), 3);
  assert.equal(countGitChanges(""), 0);
});
