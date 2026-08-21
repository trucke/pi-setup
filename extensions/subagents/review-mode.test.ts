import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Result } from "effect";
import {
  claudeCodeReviewPrompt,
  claudeStartupRejection,
} from "./src/backends/claude.ts";
import {
  codexBackend,
  codexItemIsMeaningful,
  codexReviewTarget,
  codexStartupFailure,
} from "./src/backends/codex.ts";
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

test("Codex ignores its echoed user item when classifying startup activity", () => {
  assert.equal(codexItemIsMeaningful({ type: "userMessage" }), false);
  assert.equal(codexItemIsMeaningful({ type: "agentMessage" }), true);
  assert.equal(codexItemIsMeaningful({ type: "commandExecution" }), true);
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

test("Codex review mode uses native custom review instructions", () => {
  assert.deepEqual(
    codexReviewTarget({
      ...baseTask,
      reviewTarget: { type: "baseBranch", branch: "main" },
    }),
    {
      type: "custom",
      instructions:
        "Review the changes against base branch main. Focus on lifecycle races.",
    },
  );
  assert.match(
    String(
      codexReviewTarget({
        ...baseTask,
        reviewTarget: { type: "pullRequest", number: 42 },
      }).instructions,
    ),
    /pull request #42/,
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

test("Claude review mode uses a direct read-only prompt for commit targets", () => {
  const prompt = claudeCodeReviewPrompt({
    ...baseTask,
    runMode: "code-review",
    reviewTarget: { type: "commit", sha: "abc1234" },
  });
  assert.match(prompt, /Review commit "abc1234"/);
  assert.match(prompt, /git show --format=fuller abc1234/);
  assert.match(prompt, /Focus on lifecycle races/);
  assert.match(prompt, /Do not .*post remote comments/);
  assert.doesNotMatch(prompt, /^\/code-review/m);
});

test("Claude review mode describes branch and PR targets without command expansion", () => {
  const branch = claudeCodeReviewPrompt({
    ...baseTask,
    reviewTarget: { type: "baseBranch", branch: "main" },
  });
  const pullRequest = claudeCodeReviewPrompt({
    ...baseTask,
    reviewTarget: { type: "pullRequest", number: 42 },
  });
  assert.match(branch, /git diff main\.\.\.HEAD/);
  assert.match(pullRequest, /gh pr diff 42/);
  assert.match(pullRequest, /Do not .*post remote comments/);
});
