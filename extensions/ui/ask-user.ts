import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ReportedAnswer } from "../ask-user/prompt.ts";
import type { ToolResult, ToolRowSpec } from "./tool-rows.ts";

type Answer = Partial<ReportedAnswer>;

/** Reads current and legacy (single `answer`) result details. */
function readDetails(details: unknown) {
  if (typeof details !== "object" || details === null) return undefined;
  const cancelled = "cancelled" in details && details.cancelled === true;
  if ("answers" in details && Array.isArray(details.answers)) {
    const answers: readonly Answer[] = details.answers;
    return { cancelled, answers };
  }
  if ("answer" in details && typeof details.answer === "string") {
    const answer: Answer = {
      answer: details.answer,
      wasCustom: "wasCustom" in details && details.wasCustom === true,
    };
    return { cancelled, answers: [answer] };
  }
  return { cancelled, answers: [] };
}

/** Written answers carry the same ✎ marker as the questionnaire's free-form option. */
function formatAnswer(answer: Answer) {
  const written = answer.answer ? `✎ ${answer.answer}` : undefined;
  if (answer.selected !== undefined) {
    return [...answer.selected, ...(written ? [written] : [])].join(", ");
  }
  return answer.wasCustom ? written : answer.answer;
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** The question stays as the label; the answer, which is what matters later, follows it. */
export const askUserRow: ToolRowSpec = {
  summarize(result: ToolResult, theme: Theme) {
    const details = readDetails(result.details);
    if (!details) return {};
    if (details.cancelled || details.answers.length === 0) {
      return { detail: theme.fg("warning", "dismissed") };
    }

    const batch = details.answers.length > 1;
    const text = details.answers
      .map((answer) => {
        const value = oneLine(formatAnswer(answer) ?? "");
        return batch && answer.label
          ? `${theme.fg("muted", `${answer.label}:`)} ${theme.fg("text", value)}`
          : theme.fg("text", value);
      })
      .join(theme.fg("dim", "; "));
    return { detail: text };
  },
};
