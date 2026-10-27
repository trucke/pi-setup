/** Model-facing schema descriptions for ask-user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  context:
    "What the user needs to know to answer, shown at the top of the dialog above all questions: the relevant findings, what the choices mean and your recommendation. Text you wrote before this call may not be visible to the user, so never rely on it. Keep it to a few short lines; Markdown is rendered.",
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The question to ask the user",
  questionLabel:
    "Optional short contextual label for this question, such as 'Scope' or 'Priority'",
  questions:
    "Between 1 and 4 questions. Use one array item when asking a single question. Every question must be answered before the batch can be submitted.",
  multiSelect:
    "Allow multiple options to be selected. Defaults to false. Use when the choices are not mutually exclusive; the user can also add a custom answer.",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes ask-user's single and batched multiple-choice question shapes. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one multiple-choice question or a batch of up to 4 questions. Pass every question in the questions array, including when asking only one. Each question has 2-5 options and accepts one answer by default; set multiSelect to true when multiple choices are valid. A free-form 'write my own answer' option is always added automatically and can accompany selections on multi-select questions. Every question must be answered before submitting a batch, and the user may dismiss the whole questionnaire without submitting anything. Every call carries a short context that the dialog shows above the questions.";

/** Adds ask-user's single and batched multiple-choice capability to the model prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user one or up to 4 batched multiple-choice questions (2-5 options each, plus a free-form answer)";

/** Guides the model to use ask-user for enumerable answers and batch independent questions. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user a question whose likely answers can be enumerated, use the ask-user tool instead of asking in plain text.",
  "Batch independent questions into one ask-user call when that is more efficient. Ask dependent follow-up questions only after receiving the earlier answer.",
  "Questions are single-select by default. Set multiSelect to true when multiple choices are valid. Never include a free-form option yourself; ask-user adds one automatically.",
  "Make each ask-user call self-contained: put what the user needs to decide in context, and never refer to numbered items, findings or text outside the dialog.",
];

export type ReportedAnswer = {
  label: string;
  answer: string;
} & (
  | { wasCustom: boolean; index?: number; selected?: never }
  | { selected: string[]; wasCustom?: never; index?: never }
);

function describeMultiAnswer(selected: string[], custom: string) {
  const parts = [];
  if (selected.length > 0) {
    parts.push(
      `User selected options: ${selected.map((label) => JSON.stringify(label)).join(", ")}`,
    );
  }
  if (custom) parts.push(`User wrote: ${custom}`);
  return parts.join("\n");
}

/** Builds the behavioral tool-result message returned to the parent model for an ask-user outcome. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "custom"; answer: string }
    | { kind: "selected"; answer: string; index: number | undefined }
    | { kind: "multi"; selected: string[]; answer: string }
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
    case "multi":
      return describeMultiAnswer(outcome.selected, outcome.answer);
    case "batch":
      return [
        "User submitted these answers:",
        ...outcome.answers.map((answer) => {
          if (answer.selected !== undefined) {
            return `${answer.label}: ${describeMultiAnswer(answer.selected, answer.answer)}`;
          }
          return answer.wasCustom
            ? `${answer.label}: user wrote: ${answer.answer}`
            : `${answer.label}: user selected option ${answer.index}: ${answer.answer}`;
        }),
      ].join("\n");
  }
}
