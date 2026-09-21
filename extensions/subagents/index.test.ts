import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "./index.ts";
import { resolveReviewTarget } from "./src/review.ts";

interface RegisteredTool {
  readonly name: string;
  readonly prepareArguments?: (args: unknown) => unknown;
}

function makePi(tools: RegisteredTool[]) {
  return {
    on() {},
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
}

test("review targets reject values that could become shell options or commands", () => {
  assert.deepEqual(
    resolveReviewTarget({ type: "baseBranch", branch: "release/v1.2" }),
    { type: "baseBranch", branch: "release/v1.2" },
  );
  assert.deepEqual(resolveReviewTarget({ type: "commit", sha: "abc1234" }), {
    type: "commit",
    sha: "abc1234",
  });
  assert.throws(
    () => resolveReviewTarget({ type: "baseBranch", branch: "--output=x" }),
    /safe Git branch/,
  );
  assert.throws(
    () => resolveReviewTarget({ type: "baseBranch", branch: "main; touch x" }),
    /safe Git branch/,
  );
  assert.throws(
    () => resolveReviewTarget({ type: "commit", sha: "HEAD~1" }),
    /commit hash/,
  );
});

test("registers the focused kebab-case subagent tool set", () => {
  const tools: RegisteredTool[] = [];
  subagents(makePi(tools));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "subagent-spawn",
      "subagent-spawn-direct",
      "subagent-wait",
      "subagent-cancel",
      "subagent-send",
      "subagent-resume",
      "subagent-check",
      "subagent-list",
    ],
  );
});

test("old mixed calls get actionable routing errors before creating a session", () => {
  const tools: RegisteredTool[] = [];
  subagents(makePi(tools));
  const spawn = tools.find((tool) => tool.name === "subagent-spawn")!;
  for (const override of [
    { harness: "claude" },
    { model: "opus" },
    { reasoningEffort: "high" },
  ]) {
    assert.throws(
      () => spawn.prepareArguments!({ profile: "review", ...override }),
      /use subagent-spawn-direct.*Remove profile and reviewTarget/,
    );
  }
  const direct = tools.find((tool) => tool.name === "subagent-spawn-direct")!;
  assert.throws(
    () => direct.prepareArguments!({ harness: "claude", profile: "review" }),
    /Remove those fields.*scope in prompt/,
  );
});
