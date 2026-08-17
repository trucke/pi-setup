import assert from "node:assert/strict";
import test from "node:test";
import {
  collectChangedFiles,
  getStringPath,
} from "./src/last-agent-changes.ts";

test("collects newly changed and explicitly touched files", () => {
  assert.deepEqual(
    collectChangedFiles(
      new Set(["existing.ts", "new.ts"]),
      new Set(["existing.ts"]),
      new Set(["existing.ts", "written.ts"]),
    ),
    new Set(["new.ts", "existing.ts", "written.ts"]),
  );
});

test("extracts paths only from supported tool inputs", () => {
  assert.equal(getStringPath({ path: "one.ts" }), "one.ts");
  assert.equal(getStringPath({ path: 1 }), undefined);
  assert.equal(getStringPath(null), undefined);
});
