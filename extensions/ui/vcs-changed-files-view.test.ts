import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitChangedPaths,
  sanitizeTerminalText,
} from "./vcs/changed-files-view.ts";

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

test("repository text cannot inject terminal control sequences", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTerminalText(input), "beforeafterred");
});
