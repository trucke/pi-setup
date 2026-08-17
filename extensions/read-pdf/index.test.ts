import assert from "node:assert/strict";
import test from "node:test";
import { parsePages } from "./index.ts";

test("parses individual PDF pages and ranges", () => {
  assert.deepEqual(parsePages("1, 3-5"), [
    { from: 1, to: 1 },
    { from: 3, to: 5 },
  ]);
  assert.equal(parsePages(), undefined);
});

test("rejects invalid PDF page ranges", () => {
  assert.throws(() => parsePages("5-3"), /Invalid page range/);
  assert.throws(() => parsePages("first"), /Invalid pages value/);
});
