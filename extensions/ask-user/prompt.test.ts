import assert from "node:assert/strict";
import test from "node:test";
import { buildAskUserResultMessage } from "./prompt.ts";

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
