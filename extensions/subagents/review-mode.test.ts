import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Result } from "effect";
import { claudeStartupRejection } from "./src/backends/claude.ts";
import { codexBackend, codexStartupFailure } from "./src/backends/codex.ts";
import type { SpawnTask } from "./src/domain.ts";

const baseTask = {
  prompt: "Focus on lifecycle races.",
  title: "review",
  cwd: process.cwd(),
  parent: { parentCwd: process.cwd(), projectTrusted: true },
} satisfies SpawnTask;

test("Codex refuses untrusted project configuration", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      codexBackend.spawn({
        ...baseTask,
        parent: { ...baseTask.parent, projectTrusted: false },
      }),
    ).pipe(Effect.result),
  );
  assert.ok(Result.isFailure(result));
  if (Result.isFailure(result)) {
    assert.match(result.failure.message, /untrusted project/);
  }
});

test("Codex distinguishes pre-activity rejection from terminal failure", () => {
  assert.deepEqual(
    codexStartupFailure({
      meaningfulActivity: false,
      reason: "model_not_found",
      message: "model unavailable",
    }),
    {
      _tag: "RunRejected",
      reason: "model_not_found",
      message: "model unavailable",
    },
  );
  assert.deepEqual(
    codexStartupFailure({
      meaningfulActivity: true,
      reason: "server_error",
      message: "turn failed",
      partialText: "partial",
    }),
    {
      _tag: "RunSettled",
      outcome: {
        _tag: "Failed",
        errorText: "turn failed",
        partialText: "partial",
      },
    },
  );
});

test("Claude classifies typed startup errors without parsing messages", () => {
  assert.deepEqual(claudeStartupRejection("model_not_found", 0), {
    _tag: "RunRejected",
    reason: "model_not_found",
    message: "Claude rejected the model request (model_not_found).",
  });
  assert.equal(
    claudeStartupRejection("model_not_found", 1)?.reason,
    "model_not_found",
  );
  assert.equal(claudeStartupRejection("max_output_tokens", 1), undefined);
  assert.equal(claudeStartupRejection(undefined, 0), undefined);
});
