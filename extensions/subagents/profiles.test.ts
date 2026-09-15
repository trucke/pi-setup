import assert from "node:assert/strict";
import test from "node:test";
import { PROFILE_NAMES } from "./src/domain.ts";
import {
  buildProfilePrompt,
  EXECUTION_PROFILES,
  SHARED_PROFILE_INSTRUCTIONS,
} from "./src/profiles.ts";
import { buildReviewPrompt } from "./src/review.ts";
import { SUBAGENT_SPAWN_TOOL_DESCRIPTION } from "./src/prompt.ts";

test("profiles compose shared instructions, the selected role and the complete task", () => {
  for (const profile of PROFILE_NAMES) {
    const prompt = buildProfilePrompt(
      profile,
      "  Task with specific acceptance criteria.  ",
    );
    assert.ok(prompt.startsWith(SHARED_PROFILE_INSTRUCTIONS));
    assert.ok(prompt.includes(EXECUTION_PROFILES[profile].instructions));
    assert.ok(
      prompt.endsWith("Task:\nTask with specific acceptance criteria."),
    );
    assert.equal(EXECUTION_PROFILES[profile].execution.runMode, "agent");
    assert.ok(
      SUBAGENT_SPAWN_TOOL_DESCRIPTION.includes(
        `${profile} (${EXECUTION_PROFILES[profile].description})`,
      ),
    );
  }
});

test("generic review does not invent a code-change target", () => {
  const prompt = buildProfilePrompt(
    "review",
    "Assess docs/plan.md for feasibility.",
  );
  assert.equal(buildReviewPrompt(prompt), prompt);
  assert.doesNotMatch(prompt, /git diff|uncommitted|staged changes/);
  assert.match(prompt, /docs\/plan.md/);
});

test("explicit review targets reach ordinary agent prompts", () => {
  const prompt = buildReviewPrompt(
    buildProfilePrompt("review", "Assess correctness."),
    {
      type: "commit",
      sha: "abc1234",
    },
  );
  assert.match(prompt, /Review commit "abc1234"/);
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /Assess correctness/);
});
