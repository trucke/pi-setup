import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_PROFILES } from "./src/profiles.ts";

test("execution profiles keep the reviewed candidate order", () => {
  assert.deepEqual(EXECUTION_PROFILES.scout.candidates, [
    {
      harness: "pi",
      model: "opencode-go/glm-5.3-flash",
      reasoningEffort: "high",
      runMode: "agent",
    },
    {
      harness: "pi",
      model: "openai-codex/gpt-5.6-luna",
      reasoningEffort: "xhigh",
      runMode: "agent",
    },
  ]);
  assert.deepEqual(
    EXECUTION_PROFILES.reviewer.candidates.map((candidate) => ({
      harness: candidate.harness,
      model: candidate.model,
      reasoningEffort: candidate.reasoningEffort,
      runMode: candidate.runMode,
    })),
    [
      {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        runMode: "review",
      },
      {
        harness: "claude",
        model: "claude-fable-5-1",
        reasoningEffort: "high",
        runMode: "code-review",
      },
    ],
  );
});

test("worker and oracle profiles retain explicit safe fallbacks", () => {
  assert.deepEqual(
    EXECUTION_PROFILES.worker.candidates.map(
      ({ harness, model, reasoningEffort }) => ({
        harness,
        model,
        reasoningEffort,
      }),
    ),
    [
      {
        harness: "claude",
        model: "claude-fable-5-1",
        reasoningEffort: "medium",
      },
      {
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningEffort: "high",
      },
      {
        harness: "pi",
        model: "opencode-go/glm-5.3-flash",
        reasoningEffort: "high",
      },
    ],
  );
  assert.deepEqual(EXECUTION_PROFILES.oracle.candidates, [
    {
      harness: "pi",
      model: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
      runMode: "agent",
    },
    {
      harness: "pi",
      model: "opencode-go/glm-5.3-flash",
      reasoningEffort: "high",
      runMode: "agent",
    },
  ]);
});
