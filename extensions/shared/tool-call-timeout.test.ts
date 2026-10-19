import assert from "node:assert/strict";
import test from "node:test";
import {
  runWithToolCallTimeout,
  ToolCallTimeoutError,
} from "./tool-call-timeout.ts";

test("a hung tool call fails clearly and receives an abort signal", async () => {
  let executionSignal: AbortSignal | undefined;

  await assert.rejects(
    runWithToolCallTimeout("hung_fixture", 10, undefined, (signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    }),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallTimeoutError, true);
      assert.equal(
        error instanceof Error ? error.message : "",
        'Tool call "hung_fixture" timed out after 10 ms.',
      );
      return true;
    },
  );

  assert.equal(executionSignal?.aborted, true);
  assert.equal(executionSignal?.reason instanceof ToolCallTimeoutError, true);
});

test("parent cancellation still stops the timeout wrapper immediately", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled fixture");
  const pending = runWithToolCallTimeout(
    "hung_fixture",
    60_000,
    controller.signal,
    () => new Promise(() => {}),
  );

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
});
