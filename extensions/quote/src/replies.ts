import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripBlankLines } from "./blocks.ts";

/**
 * The visible text of the agent's latest message on the branch. Thinking and
 * tool calls are not quotable, so a message with only those is skipped.
 */
export function latestAnswer(entries: readonly SessionEntry[]) {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const text = stripBlankLines(
      entry.message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n"),
    );
    if (text.trim()) return text;
  }
  return undefined;
}
