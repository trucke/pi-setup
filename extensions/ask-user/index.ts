/**
 * ask-user - Lets the model ask single- or multi-select questions.
 *
 * - One question, or a batch of up to 4 questions
 * - Optional, brief context appears directly above the question border
 * - 2 to 5 model-provided options per question, plus "Write my own answer"
 * - Batched questions use tabs and a final review/submit step
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the questionnaire dismisses it without submitting partial answers
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  Key,
  Markdown,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import { withHerdrBlocked } from "../shared/herdr.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
  type ReportedAnswer,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_QUESTIONS = 1;
const MAX_CONTEXT_LENGTH = 300;
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
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.multiSelect,
    }),
  ),
});

const AskUserParams = Type.Object({
  context: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_CONTEXT_LENGTH,
      pattern: "^[^\\r\\n]*$",
      description: ASK_USER_PARAMETER_DESCRIPTIONS.context,
    }),
  ),
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;
type QuestionInput = Static<typeof QuestionSchema>;
type OptionInput = Static<typeof OptionSchema>;
type LegacySingleQuestionInput = Pick<QuestionInput, "question" | "options">;
/** Arguments as stored in sessions, including calls recorded before context existed. */
type RecordedInput = (
  Omit<AskUserInput, "context"> | LegacySingleQuestionInput
) & { context?: string };

interface NormalizedQuestion {
  label: string;
  question: string;
  options: OptionInput[];
  multiSelect: boolean;
}

type AskUserAnswer = ReportedAnswer & {
  questionIndex: number;
  question: string;
  options: string[];
};

interface AskUserDetails {
  questions: Array<{
    label: string;
    question: string;
    options: string[];
    multiSelect?: true;
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
  kind: "option" | "custom" | "done";
}

export function normalizeQuestions(params: AskUserInput) {
  const singleQuestion = params.questions.length === 1;
  return params.questions.map((question, index) => ({
    label:
      question.label?.trim() || (singleQuestion ? "Question" : `Q${index + 1}`),
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect ?? false,
  }));
}

function prepareAskUserArguments(args: unknown): AskUserInput {
  // Pi validates this compatibility hook's result against AskUserParams next.
  if (!args || typeof args !== "object") return args as AskUserInput;

  const input = args as {
    context?: unknown;
    questions?: unknown;
    question?: unknown;
    options?: unknown;
  };
  if (
    input.questions !== undefined ||
    typeof input.question !== "string" ||
    !Array.isArray(input.options)
  ) {
    return args as AskUserInput;
  }

  return {
    context: input.context,
    questions: [
      {
        question: input.question,
        options: input.options as OptionInput[],
      },
    ],
  } as AskUserInput;
}

function validateQuestions(questions: NormalizedQuestion[]) {
  if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    throw new Error(
      `ask-user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (got ${questions.length}). Retry with a valid number of questions.`,
    );
  }

  questions.forEach((question, index) => {
    if (
      question.options.length < MIN_OPTIONS ||
      question.options.length > MAX_OPTIONS
    ) {
      throw new Error(
        `ask-user question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${question.options.length}). Retry with a valid number of options.`,
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
      ...(question.multiSelect ? { multiSelect: true as const } : {}),
    })),
    answers,
    cancelled,
  };
}

function isLegacyDetails(
  details: AskUserDetails | LegacyAskUserDetails,
): details is LegacyAskUserDetails {
  return "answer" in details;
}

function answerText(answer: AskUserAnswer) {
  if (answer.selected !== undefined) {
    return [
      ...answer.selected,
      ...(answer.answer ? [`(wrote) ${answer.answer}`] : []),
    ].join("; ");
  }
  return answer.wasCustom ? `(wrote) ${answer.answer}` : answer.answer;
}

export default function askUser(pi: ExtensionAPI) {
  let hiddenWithoutUI = false;
  const reconcileTool = (_event: unknown, ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    const available = ctx.mode === "tui" && ctx.hasUI;
    if (!available && active.includes("ask-user")) {
      hiddenWithoutUI = true;
      pi.setActiveTools(active.filter((name) => name !== "ask-user"));
    } else if (available && hiddenWithoutUI) {
      hiddenWithoutUI = false;
      if (!active.includes("ask-user"))
        pi.setActiveTools([...active, "ask-user"]);
    }
  };
  pi.on("session_start", reconcileTool);
  pi.on("before_agent_start", reconcileTool);

  pi.registerTool({
    name: "ask-user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    prepareArguments: prepareAskUserArguments,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const context = params.context?.trim();
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

      if (ctx.mode !== "tui" || !ctx.hasUI) {
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
          const selections = new Map<number, Set<number>>();
          const customAnswers = new Map<number, string>();
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
          const contextView = context
            ? new Markdown(context, 0, 0, getMarkdownTheme())
            : undefined;

          let currentTab = 0;
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;
          let cachedWidth = 0;
          let cachedRows = 0;
          let scrollTop = 0;
          let bodyHeight = 1;
          let bodyLength = 0;
          let revealFocus = true;
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

          function refresh(followFocus = true) {
            revealFocus = followFocus;
            cachedLines = undefined;
            tui.requestRender();
          }

          function currentQuestion() {
            return questions[currentTab];
          }

          function currentOptions(): DisplayOption[] {
            const question = currentQuestion();
            if (!question) return [];
            const answer = answers.get(currentTab);
            return [
              ...question.options.map((option) => ({
                ...option,
                kind: "option" as const,
              })),
              {
                label: "Write my own answer…",
                description: question.multiSelect
                  ? customAnswers.get(currentTab)
                  : answer?.wasCustom
                    ? answer.answer
                    : undefined,
                kind: "custom",
              },
              ...(question.multiSelect
                ? [{ label: "Done", kind: "done" as const }]
                : []),
            ] satisfies DisplayOption[];
          }

          function selectTab(tab: number) {
            currentTab = (tab + tabCount) % tabCount;
            editMode = false;
            editor.setText("");
            scrollTop = 0;

            const existing = answers.get(currentTab);
            if (existing?.selected !== undefined) {
              optionIndex = questions[currentTab].options.findIndex((option) =>
                existing.selected.includes(option.label),
              );
              if (optionIndex < 0)
                optionIndex = questions[currentTab].options.length;
            } else if (existing?.wasCustom) {
              optionIndex = questions[currentTab].options.length;
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
            editMode = false;
            editor.setText("");
            if (currentQuestion().multiSelect) {
              if (trimmed) customAnswers.set(currentTab, trimmed);
              else customAnswers.delete(currentTab);
              answers.delete(currentTab);
              optionIndex = currentOptions().length - 1;
              refresh();
            } else if (trimmed) {
              saveAnswer(currentTab, trimmed, true);
              advanceAfterAnswer();
            } else {
              refresh();
            }
          };

          function toggleOption(index: number) {
            const selected = selections.get(currentTab) ?? new Set<number>();
            if (selected.has(index)) selected.delete(index);
            else selected.add(index);
            selections.set(currentTab, selected);
            answers.delete(currentTab);
            refresh();
          }

          function commitMultiAnswer() {
            const question = currentQuestion();
            const selected = question.options
              .filter((_option, index) =>
                selections.get(currentTab)?.has(index),
              )
              .map((option) => option.label);
            const answer = customAnswers.get(currentTab) ?? "";
            if (selected.length === 0 && !answer) return;
            answers.set(currentTab, {
              questionIndex: currentTab,
              label: question.label,
              question: question.question,
              options: question.options.map((option) => option.label),
              selected,
              answer,
            });
            advanceAfterAnswer();
          }

          function selectOption(index: number) {
            const selected = currentOptions()[index];
            if (!selected) return;

            optionIndex = index;
            if (selected.kind === "custom") {
              editMode = true;
              const existing = answers.get(currentTab);
              editor.setText(
                currentQuestion().multiSelect
                  ? (customAnswers.get(currentTab) ?? "")
                  : existing?.wasCustom
                    ? existing.answer
                    : "",
              );
              refresh();
            } else if (selected.kind === "done") {
              commitMultiAnswer();
            } else if (currentQuestion().multiSelect) {
              toggleOption(index);
            } else {
              saveAnswer(currentTab, selected.label, false, index + 1);
              advanceAfterAnswer();
            }
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

            // Unmodified PageUp/PageDown belong to Pi's transcript in fullscreen mode.
            const pageUp = matchesKey(data, Key.ctrl("pageUp"));
            if (pageUp || matchesKey(data, Key.ctrl("pageDown"))) {
              const direction = pageUp ? -1 : 1;
              scrollTop = Math.max(
                0,
                Math.min(
                  scrollTop + direction * Math.max(1, bodyHeight - 1),
                  bodyLength - bodyHeight,
                ),
              );
              refresh(false);
              return;
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
              data <= String(currentQuestion().options.length + 1)
            ) {
              selectOption(Number(data) - 1);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }
            if (
              matchesKey(data, Key.space) &&
              currentQuestion().multiSelect &&
              options[optionIndex].kind === "option"
            ) {
              toggleOption(optionIndex);
              return;
            }

            if (matchesKey(data, Key.escape)) {
              finish(null);
            }
          }

          function render(width: number) {
            const rows = Math.max(4, tui.terminal.rows || 30);
            const renderWidth = Math.max(1, width);
            if (
              cachedLines &&
              cachedWidth === renderWidth &&
              cachedRows === rows
            )
              return cachedLines;
            if (cachedWidth !== renderWidth || cachedRows !== rows)
              revealFocus = true;
            cachedWidth = renderWidth;
            cachedRows = rows;

            // Plain decision context stays adjacent to the question box, outside
            // its border and without the transcript tool row's wrapper or gap.
            const intro = contextView
              ? [
                  ...contextView
                    .render(Math.max(1, renderWidth - 2))
                    .map((line) => ` ${line}`),
                  "",
                ]
              : [];
            const rowBudget = Math.max(
              4,
              Math.min(rows - 2, Math.max(12, Math.floor(rows * 0.7))) -
                intro.length,
            );
            const heading: string[] = [];
            const body: string[] = [];
            let focus: [number, number] | undefined;
            const question = currentQuestion();
            const options = currentOptions();
            const title = isBatch ? " Questions " : " Question ";
            heading.push(
              theme.fg(
                "accent",
                `─${title}${"─".repeat(Math.max(0, renderWidth - title.length - 1))}`,
              ),
            );

            if (isBatch) {
              const labelWidth = Math.max(
                1,
                Math.floor((renderWidth - 15) / questions.length) - 5,
              );
              const tabs = questions.map((item, index) => {
                const answered = answers.has(index);
                const text = ` ${answered ? "■" : "□"} ${truncateToWidth(item.label, labelWidth)} `;
                return index === currentTab
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(answered ? "success" : "muted", text);
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
              heading.push(` ${tabs.join(" ")}`);
            }

            if (currentTab === submitTab) {
              heading.push(
                theme.fg("accent", theme.bold(" Review your answers")),
              );
              for (let index = 0; index < questions.length; index++) {
                const answer = answers.get(index);
                const text = `${questions[index].label}: ${answer ? answerText(answer) : "Unanswered"}`;
                for (const line of wrapTextWithAnsi(
                  text,
                  Math.max(1, renderWidth - 2),
                )) {
                  body.push(` ${theme.fg(answer ? "text" : "warning", line)}`);
                }
                body.push("");
              }
              body.push(
                theme.fg(
                  answers.size === questions.length ? "success" : "warning",
                  answers.size === questions.length
                    ? " Press Enter to submit"
                    : " Answer every question before submitting",
                ),
              );
            } else if (question) {
              for (const line of wrapTextWithAnsi(
                question.question,
                Math.max(1, renderWidth - 2),
              )) {
                heading.push(` ${theme.fg("text", theme.bold(line))}`);
              }
              heading.push("");

              for (let index = 0; index < options.length; index++) {
                const option = options[index];
                const start = body.length;
                const highlighted = index === optionIndex;
                const checked =
                  option.kind === "option"
                    ? selections.get(currentTab)?.has(index)
                    : customAnswers.has(currentTab);
                const marker =
                  option.kind === "done"
                    ? "→"
                    : `${question.multiSelect ? `[${checked ? "x" : " "}] ` : ""}${option.kind === "custom" ? "✎" : `${index + 1}.`}`;
                const indent = " ".repeat(3 + marker.length + 1);
                const textWidth = Math.max(1, renderWidth - indent.length);
                const color = highlighted
                  ? "accent"
                  : option.kind === "option"
                    ? "text"
                    : "muted";
                const [first = "", ...rest] = wrapTextWithAnsi(
                  option.label,
                  textWidth,
                );
                body.push(
                  `${highlighted ? theme.fg("accent", " ❯ ") : "   "}${theme.fg(color, `${marker} ${first}`)}`,
                );
                body.push(
                  ...rest.map((line) => `${indent}${theme.fg(color, line)}`),
                );
                const description =
                  option.kind === "done" &&
                  !selections.get(currentTab)?.size &&
                  !customAnswers.has(currentTab)
                    ? "Select at least one option or write an answer."
                    : option.description;
                if (description) {
                  for (const line of wrapTextWithAnsi(description, textWidth)) {
                    body.push(`${indent}${theme.fg("muted", line)}`);
                  }
                }
                if (highlighted) focus = [start, body.length];
              }

              if (editMode) {
                body.push("", theme.fg("muted", " Your answer:"));
                const editorLines = editor.render(Math.max(1, renderWidth - 2));
                const cursorRow = editorLines.findIndex((line) =>
                  line.includes(CURSOR_MARKER),
                );
                const focusRow =
                  body.length +
                  (cursorRow < 0 ? editorLines.length - 2 : cursorRow);
                focus = [focusRow, focusRow + 1];
                body.push(...editorLines.map((line) => ` ${line}`));
              }
            }

            const tabHint = isBatch ? "Tab tabs • " : "";
            let hint = editMode
              ? ` Enter ${question?.multiSelect ? "save text" : "submit"} • Esc back to options`
              : currentTab === submitTab
                ? " Tab/←→ navigate • Enter submit • Esc dismiss"
                : question?.multiSelect
                  ? ` ${tabHint}↑↓ move • Space/Enter toggle • Done confirm • Esc dismiss`
                  : ` ${tabHint}↑↓/jk move • 1-${options.length} choose • Enter confirm • Esc dismiss`;
            if (visibleWidth(hint) > renderWidth) {
              hint = editMode
                ? " Enter save • Esc back"
                : question?.multiSelect
                  ? " Space toggle • Done confirm • Esc dismiss"
                  : " Enter confirm • Esc dismiss";
            }
            const footerRows = rowBudget >= 6 ? 3 : 1;
            const headingRows = Math.max(
              1,
              Math.min(Math.floor(rowBudget / 2), rowBudget - footerRows - 1),
            );
            // Very long questions remain readable by scrolling, rather than being discarded.
            const headingOverflow = heading.splice(headingRows);
            body.unshift(...headingOverflow);
            const offset = headingOverflow.length;
            if (focus) focus = [focus[0] + offset, focus[1] + offset];
            bodyHeight = Math.max(1, rowBudget - heading.length - footerRows);
            bodyLength = body.length;

            // Clip explicitly: ScrollView's layout clipping is only available in fullscreen mode.
            if (revealFocus && focus) {
              if (focus[0] < scrollTop) scrollTop = focus[0];
              if (focus[1] > scrollTop + bodyHeight) {
                if (focus[1] - focus[0] <= bodyHeight)
                  scrollTop = focus[1] - bodyHeight;
                // For an option taller than the view, keep its first line visible.
                else if (focus[0] >= scrollTop + bodyHeight)
                  scrollTop = focus[0];
              }
            }
            scrollTop = Math.max(
              0,
              Math.min(scrollTop, body.length - bodyHeight),
            );
            revealFocus = false;
            const overflow = [
              ...(scrollTop > 0 ? ["↑ more above"] : []),
              ...(scrollTop + bodyHeight < body.length ? ["↓ more below"] : []),
            ];
            let scrollHint = ` ${overflow.join(" • ")} • Ctrl+PgUp/PgDn scroll`;
            if (visibleWidth(scrollHint) > renderWidth) {
              scrollHint = ` ${scrollTop > 0 ? "↑" : ""}${scrollTop + bodyHeight < body.length ? "↓" : ""} Ctrl+PgUp/PgDn scroll`;
            }
            const footer =
              footerRows === 1
                ? [theme.fg("dim", hint)]
                : [
                    overflow.length ? theme.fg("dim", scrollHint) : "",
                    theme.fg("dim", hint),
                    theme.fg("accent", "─".repeat(renderWidth)),
                  ];
            const visible = body.slice(scrollTop, scrollTop + bodyHeight);
            cachedLines = [...intro, ...heading, ...visible, ...footer].map(
              (line) => truncateToWidth(line, renderWidth),
            );
            return cachedLines;
          }

          return {
            render,
            get focused() {
              return editor.focused;
            },
            set focused(value: boolean) {
              editor.focused = value;
            },
            invalidate: () => {
              cachedLines = undefined;
              editor.invalidate();
              contextView?.invalidate();
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
        });

      const uiExit = await withHerdrBlocked(pi, "Waiting for your answer", () =>
        Effect.runPromiseExit(
          Effect.tryPromise(showQuestions),
          signal ? { signal } : undefined,
        ),
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
        if (answer.selected !== undefined) {
          return reply(
            buildAskUserResultMessage({
              kind: "multi",
              selected: answer.selected,
              answer: answer.answer,
            }),
            result.answers,
            false,
          );
        }
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

    renderCall(args, theme, renderContext) {
      const input = args as RecordedInput;
      const title = theme.fg("toolTitle", theme.bold("ask-user"));
      // Keep context reviewable after the interactive question box is gone.
      const context = renderContext.expanded
        ? input.context?.trim()
        : undefined;
      const prefix = context ? "  " : `${title} `;

      const renderSingle = (question: LegacySingleQuestionInput) => {
        let text = prefix;
        text += theme.fg("muted", question.question);
        if (question.options.length > 0) {
          const numbered = question.options.map(
            (option, index) => `${index + 1}. ${option.label}`,
          );
          text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
        }
        return new Text(text, 0, 0);
      };

      const renderSummary = (input: RecordedInput) => {
        if (!("questions" in input)) {
          return "question" in input && Array.isArray(input.options)
            ? renderSingle(input)
            : new Text(title, 0, 0);
        }

        const [singleQuestion] = input.questions;
        if (input.questions.length === 1 && singleQuestion) {
          return renderSingle(singleQuestion);
        }

        // Question labels are shown with each answer in the result.
        let text = prefix;
        text += theme.fg("muted", `${input.questions.length} questions`);
        return new Text(text, 0, 0);
      };

      const summary = renderSummary(input);
      if (!context) return summary;

      const titleView = new Text(title, 0, 0);
      const contextView = new Markdown(context, 2, 0, getMarkdownTheme());
      return {
        render: (width: number) => [
          ...titleView.render(width),
          ...contextView.render(width),
          ...summary.render(width),
        ],
        invalidate: () => {
          titleView.invalidate();
          contextView.invalidate();
          summary.invalidate();
        },
      };
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
        const display =
          answer.selected !== undefined
            ? theme.fg("accent", answerText(answer))
            : answer.wasCustom
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
