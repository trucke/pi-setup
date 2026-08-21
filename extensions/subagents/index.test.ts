import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents, { resolveReviewTarget } from "./index.ts";

interface RegisteredTool {
  readonly name: string;
  readonly parameters?: { readonly properties?: Record<string, unknown> };
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
      "subagent-wait",
      "subagent-cancel",
      "subagent-send",
      "subagent-resume",
      "subagent-check",
      "subagent-list",
    ],
  );
});

test("spawn exposes profiles and camelCase direct settings without aliases", () => {
  const tools: RegisteredTool[] = [];
  subagents(makePi(tools));
  const spawn = tools.find((tool) => tool.name === "subagent-spawn");
  assert.deepEqual(Object.keys(spawn?.parameters?.properties ?? {}), [
    "prompt",
    "name",
    "profile",
    "harness",
    "workingDir",
    "model",
    "reasoningEffort",
    "reviewTarget",
  ]);
  const profile = spawn?.parameters?.properties?.profile as {
    enum?: ReadonlyArray<string>;
  };
  assert.deepEqual(profile.enum, ["scout", "worker", "reviewer", "oracle"]);
  assert.equal(spawn?.parameters?.properties?.working_dir, undefined);
  assert.equal(spawn?.parameters?.properties?.reasoning_effort, undefined);
});

test("resume can explicitly bypass a stale native session", () => {
  const tools: RegisteredTool[] = [];
  subagents(makePi(tools));
  const resume = tools.find((tool) => tool.name === "subagent-resume");
  assert.deepEqual(Object.keys(resume?.parameters?.properties ?? {}), [
    "id",
    "prompt",
    "mode",
  ]);
  assert.deepEqual(
    (
      resume?.parameters?.properties?.mode as {
        enum?: ReadonlyArray<string>;
      }
    ).enum,
    ["auto", "native", "continuation"],
  );
});

test("wait exposes wait-for-any and a non-cancelling timeout", () => {
  const tools: RegisteredTool[] = [];
  subagents(makePi(tools));
  const wait = tools.find((tool) => tool.name === "subagent-wait");
  assert.deepEqual(Object.keys(wait?.parameters?.properties ?? {}), [
    "ids",
    "mode",
    "timeoutMs",
  ]);
  assert.deepEqual(
    (wait?.parameters?.properties?.mode as { enum?: ReadonlyArray<string> })
      .enum,
    ["all", "any"],
  );
});
