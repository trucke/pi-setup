import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

test("describes batched single-select questions to the model", () => {
  assert.match(ASK_USER_TOOL_DESCRIPTION, /batch of up to 4 questions/);
  assert.match(ASK_USER_TOOL_DESCRIPTION, /accepts one answer/);
  assert.ok(
    ASK_USER_PROMPT_GUIDELINES.some((guideline) =>
      guideline.includes("Batch independent questions"),
    ),
  );
});

test("formats batched selected and custom answers", () => {
  assert.equal(
    buildAskUserResultMessage({
      kind: "batch",
      answers: [
        {
          label: "Scope",
          answer: "Repository",
          wasCustom: false,
          index: 2,
        },
        {
          label: "Notes",
          answer: "Keep it concise",
          wasCustom: true,
        },
      ],
    }),
    [
      "User submitted these answers:",
      "Scope: user selected option 2: Repository",
      "Notes: user wrote: Keep it concise",
    ].join("\n"),
  );
});
