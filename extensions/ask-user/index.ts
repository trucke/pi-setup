/**
 * ask_user - Lets the model ask one or more single-select questions.
 *
 * - One question, or a batch of up to 4 questions
 * - 2 to 5 model-provided options per question, plus "Write my own answer"
 * - Batched questions use tabs and a final review/submit step
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the questionnaire dismisses it without submitting partial answers
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const QuestionSchema = Type.Object({
  label: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionLabel,
    }),
  ),
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

const SingleQuestionParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

const BatchQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

const AskUserParams = Type.Union([SingleQuestionParams, BatchQuestionParams]);

export type AskUserInput = Static<typeof AskUserParams>;
type QuestionInput = Static<typeof QuestionSchema>;
type OptionInput = Static<typeof OptionSchema>;

interface NormalizedQuestion {
  label: string;
  question: string;
  options: OptionInput[];
}

interface AskUserAnswer {
  questionIndex: number;
  label: string;
  question: string;
  options: string[];
  answer: string;
  wasCustom: boolean;
  index?: number;
}

interface AskUserDetails {
  questions: Array<{
    label: string;
    question: string;
    options: string[];
  }>;
  answers: AskUserAnswer[];
  cancelled: boolean;
}

interface LegacyAskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type SelectionResult = {
  answers: AskUserAnswer[];
} | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export function normalizeQuestions(params: AskUserInput) {
  if ("questions" in params) {
    return params.questions.map((question, index) => ({
      label: question.label?.trim() || `Q${index + 1}`,
      question: question.question,
      options: question.options,
    }));
  }

  return [
    {
      label: "Question",
      question: params.question,
      options: params.options,
    },
  ];
}

function validateQuestions(questions: NormalizedQuestion[]) {
  if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    throw new Error(
      `ask_user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (got ${questions.length}). Retry with a valid number of questions.`,
    );
  }

  questions.forEach((question, index) => {
    if (
      question.options.length < MIN_OPTIONS ||
      question.options.length > MAX_OPTIONS
    ) {
      throw new Error(
        `ask_user question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${question.options.length}). Retry with a valid number of options.`,
      );
    }
  });
}

function detailsFor(
  questions: NormalizedQuestion[],
  answers: AskUserAnswer[],
  cancelled: boolean,
): AskUserDetails {
  return {
    questions: questions.map((question) => ({
      label: question.label,
      question: question.question,
      options: question.options.map((option) => option.label),
    })),
    answers,
    cancelled,
  };
}

function wrapText(text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function isLegacyDetails(
  details: AskUserDetails | LegacyAskUserDetails,
): details is LegacyAskUserDetails {
  return "answer" in details;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params);
      validateQuestions(questions);

      const reply = (
        text: string,
        answers: AskUserAnswer[] = [],
        cancelled = answers.length === 0,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: detailsFor(questions, answers, cancelled),
      });

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showQuestions = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          const isBatch = questions.length > 1;
          const submitTab = questions.length;
          const tabCount = questions.length + 1;
          const answers = new Map<number, AskUserAnswer>();
          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          let currentTab = 0;
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;
          let settled = false;

          function orderedAnswers() {
            return [...answers.values()].sort(
              (left, right) => left.questionIndex - right.questionIndex,
            );
          }

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function currentQuestion() {
            return questions[currentTab];
          }

          function currentOptions(): DisplayOption[] {
            const question = currentQuestion();
            if (!question) return [];
            return [
              ...question.options,
              {
                label: "Write my own answer…",
                isOther: true,
              },
            ] satisfies DisplayOption[];
          }

          function selectTab(tab: number) {
            currentTab = (tab + tabCount) % tabCount;
            editMode = false;
            editor.setText("");

            const existing = answers.get(currentTab);
            if (existing?.wasCustom) {
              optionIndex = currentOptions().length - 1;
            } else if (existing?.index) {
              optionIndex = existing.index - 1;
            } else {
              optionIndex = 0;
            }
            refresh();
          }

          function saveAnswer(
            questionIndex: number,
            answer: string,
            wasCustom: boolean,
            index?: number,
          ) {
            const question = questions[questionIndex];
            answers.set(questionIndex, {
              questionIndex,
              label: question.label,
              question: question.question,
              options: question.options.map((option) => option.label),
              answer,
              wasCustom,
              index,
            });
          }

          function advanceAfterAnswer() {
            if (!isBatch) {
              finish({ answers: orderedAnswers() });
              return;
            }

            selectTab(
              currentTab < questions.length - 1 ? currentTab + 1 : submitTab,
            );
          }

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              editMode = false;
              editor.setText("");
              refresh();
              return;
            }

            saveAnswer(currentTab, trimmed, true);
            editMode = false;
            editor.setText("");
            advanceAfterAnswer();
          };

          function selectOption(index: number) {
            const selected = currentOptions()[index];
            if (!selected) return;

            if (selected.isOther) {
              optionIndex = index;
              editMode = true;
              const existing = answers.get(currentTab);
              editor.setText(existing?.wasCustom ? existing.answer : "");
              refresh();
              return;
            }

            saveAnswer(currentTab, selected.label, false, index + 1);
            advanceAfterAnswer();
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (isBatch) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                selectTab(currentTab + 1);
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                selectTab(currentTab - 1);
                return;
              }
            }

            if (currentTab === submitTab) {
              if (
                matchesKey(data, Key.enter) &&
                answers.size === questions.length
              ) {
                finish({ answers: orderedAnswers() });
              } else if (matchesKey(data, Key.escape)) {
                finish(null);
              }
              return;
            }

            const options = currentOptions();
            if (matchesKey(data, Key.up) || data === "k") {
              optionIndex = (optionIndex - 1 + options.length) % options.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down) || data === "j") {
              optionIndex = (optionIndex + 1) % options.length;
              refresh();
              return;
            }

            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(options.length)
            ) {
              selectOption(Number(data) - 1);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }

            if (matchesKey(data, Key.escape)) {
              finish(null);
            }
          }

          function render(width: number) {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const renderWidth = Math.max(1, width);
            const add = (text: string) =>
              lines.push(truncateToWidth(text, renderWidth));
            const question = currentQuestion();
            const options = currentOptions();

            const title = isBatch ? " Questions " : " Question ";
            add(
              theme.fg(
                "accent",
                `─${title}${"─".repeat(Math.max(0, renderWidth - title.length - 1))}`,
              ),
            );

            if (isBatch) {
              const tabs = questions.map((item, index) => {
                const answered = answers.has(index);
                const marker = answered ? "■" : "□";
                const text = ` ${marker} ${item.label} `;
                if (index === currentTab) {
                  return theme.bg("selectedBg", theme.fg("text", text));
                }
                return theme.fg(answered ? "success" : "muted", text);
              });
              const submitText = " ✓ Submit ";
              tabs.push(
                currentTab === submitTab
                  ? theme.bg("selectedBg", theme.fg("text", submitText))
                  : theme.fg(
                      answers.size === questions.length ? "success" : "dim",
                      submitText,
                    ),
              );
              add(` ${tabs.join(" ")}`);
              lines.push("");
            }

            if (currentTab === submitTab) {
              add(theme.fg("accent", theme.bold(" Ready to submit")));
              lines.push("");
              for (let index = 0; index < questions.length; index++) {
                const item = questions[index];
                const answer = answers.get(index);
                if (!answer) continue;
                const prefix = answer.wasCustom ? "(wrote) " : "";
                add(
                  ` ${theme.fg("muted", `${item.label}: `)}${theme.fg("text", prefix + answer.answer)}`,
                );
              }
              lines.push("");
              if (answers.size === questions.length) {
                add(theme.fg("success", " Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((_item, index) => !answers.has(index))
                  .map((item) => item.label)
                  .join(", ");
                add(theme.fg("warning", ` Unanswered: ${missing}`));
              }
            } else if (question) {
              for (const line of wrapText(
                question.question,
                Math.max(10, renderWidth - 2),
              )) {
                add(` ${theme.fg("text", theme.bold(line))}`);
              }
              lines.push("");

              for (let index = 0; index < options.length; index++) {
                const option = options[index];
                const selected = index === optionIndex;
                const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
                const marker = option.isOther ? "✎" : `${index + 1}.`;
                const label = `${marker} ${option.label}`;
                add(
                  prefix +
                    theme.fg(
                      selected || (option.isOther && editMode)
                        ? "accent"
                        : option.isOther
                          ? "muted"
                          : "text",
                      label,
                    ),
                );
                if (option.description) {
                  add(`      ${theme.fg("muted", option.description)}`);
                }
              }

              if (editMode) {
                lines.push("");
                add(theme.fg("muted", " Your answer:"));
                for (const line of editor.render(
                  Math.max(1, renderWidth - 2),
                )) {
                  add(` ${line}`);
                }
              }
            }

            lines.push("");
            if (editMode) {
              add(theme.fg("dim", " Enter submit • Esc back to options"));
            } else if (isBatch && currentTab === submitTab) {
              add(
                theme.fg(
                  "dim",
                  " Tab/←→ navigate • Enter submit • Esc dismiss",
                ),
              );
            } else if (isBatch) {
              add(
                theme.fg(
                  "dim",
                  ` Tab/←→ navigate • k/↑ j/↓ or 1-${options.length} select • Enter confirm • Esc dismiss`,
                ),
              );
            } else {
              add(
                theme.fg(
                  "dim",
                  ` k/↑ j/↓ or 1-${options.length} select • Enter confirm • Esc dismiss`,
                ),
              );
            }
            add(theme.fg("accent", "─".repeat(renderWidth)));

            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestions),
        signal ? { signal } : undefined,
      );

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;
      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      const [answer] = result.answers;
      if (result.answers.length === 1) {
        return reply(
          answer.wasCustom
            ? buildAskUserResultMessage({
                kind: "custom",
                answer: answer.answer,
              })
            : buildAskUserResultMessage({
                kind: "selected",
                answer: answer.answer,
                index: answer.index,
              }),
          result.answers,
          false,
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "batch",
          answers: result.answers,
        }),
        result.answers,
        false,
      );
    },

    renderCall(args, theme, _context) {
      if ("questions" in args) {
        const count = args.questions.length;
        const labels = args.questions
          .map(
            (question: QuestionInput, index: number) =>
              question.label?.trim() || `Q${index + 1}`,
          )
          .join(", ");
        let text = theme.fg("toolTitle", theme.bold("ask_user "));
        text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
        if (labels) text += theme.fg("dim", ` (${labels})`);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        typeof args.question === "string" ? args.question : "",
      );
      const options = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      if (options.length > 0) {
        const numbered = options.map(
          (option, index) => `${index + 1}. ${option.label}`,
        );
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        AskUserDetails | LegacyAskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (isLegacyDetails(details)) {
        if (details.cancelled || details.answer === null) {
          return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
        }
        if (details.wasCustom) {
          return new Text(
            theme.fg("success", "✓ ") +
              theme.fg("muted", "(wrote) ") +
              theme.fg("accent", details.answer),
            0,
            0,
          );
        }
        const index = details.options.indexOf(details.answer) + 1;
        const display =
          index > 0 ? `${index}. ${details.answer}` : details.answer;
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("accent", display),
          0,
          0,
        );
      }

      if (details.cancelled || details.answers.length === 0) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      const showLabels = details.questions.length > 1;
      const lines = details.answers.map((answer) => {
        const prefix = showLabels
          ? `${theme.fg("accent", answer.label)}: `
          : "";
        const display = answer.wasCustom
          ? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", answer.answer)}`
          : theme.fg(
              "accent",
              answer.index
                ? `${answer.index}. ${answer.answer}`
                : answer.answer,
            );
        return `${theme.fg("success", "✓ ")}${prefix}${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
