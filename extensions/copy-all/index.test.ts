import assert from "node:assert/strict";
import test from "node:test";
import { clipboardCommand } from "./index.ts";

test("uses pbcopy on macOS", () => {
  assert.deepEqual(clipboardCommand("darwin"), {
    command: "pbcopy",
    args: [],
  });
});

test("uses wl-copy on Linux", () => {
  assert.deepEqual(clipboardCommand("linux"), {
    command: "wl-copy",
    args: [],
  });
});

test("rejects unsupported platforms", () => {
  assert.throws(
    () => clipboardCommand("win32"),
    /does not support the win32 platform/,
  );
});
