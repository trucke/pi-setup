import assert from "node:assert/strict";
import test from "node:test";
import { longBashBlockReason, MAX_BASH_TIMEOUT_SECONDS } from "./src/prompt.ts";

test("bash timeouts up to the limit run; longer ones are sent to bg-start", () => {
  assert.equal(longBashBlockReason(undefined), undefined);
  assert.equal(longBashBlockReason(MAX_BASH_TIMEOUT_SECONDS), undefined);
  assert.match(
    longBashBlockReason(MAX_BASH_TIMEOUT_SECONDS + 1) ?? "",
    /bg-start/,
  );
});
