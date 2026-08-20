/** Model-facing schema descriptions for ask-user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The question to ask the user",
  questionLabel:
    "Optional short contextual label for this question, such as 'Scope' or 'Priority'",
  questions:
    "Between 1 and 4 questions to ask together. Each question is single-select.",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes ask-user's single and batched single-select question shapes. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one multiple-choice question or a batch of up to 4 questions. Each question has 2-5 options and accepts one answer. A free-form 'write my own answer' option is always added automatically, and the user may dismiss the questionnaire without answering. Use the single question/options fields for one question or questions for a batch.";

/** Adds ask-user's single and batched multiple-choice capability to the model prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user one or up to 4 batched multiple-choice questions (2-5 options each, plus a free-form answer)";

/** Guides the model to use ask-user for enumerable answers and batch independent questions. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user a question whose likely answers can be enumerated, use the ask-user tool instead of asking in plain text.",
  "Batch independent questions into one ask-user call when that is more efficient. Ask dependent follow-up questions only after receiving the earlier answer.",
  "Each question is single-select. Never include a free-form option yourself; ask-user adds one automatically.",
];

type ReportedAnswer = {
  label: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
};

/** Builds the behavioral tool-result message returned to the parent model for an ask-user outcome. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "custom"; answer: string }
    | { kind: "selected"; answer: string; index: number | undefined }
    | { kind: "batch"; answers: ReportedAnswer[] },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questionnaire could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questionnaire without submitting answers. Do not assume any answers; proceed accordingly or ask differently.";
    case "custom":
      return `User wrote their own answer: ${outcome.answer}`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
    case "batch":
      return [
        "User submitted these answers:",
        ...outcome.answers.map((answer) =>
          answer.wasCustom
            ? `${answer.label}: user wrote: ${answer.answer}`
            : `${answer.label}: user selected option ${answer.index}: ${answer.answer}`,
        ),
      ].join("\n");
  }
}
