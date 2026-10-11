import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { latestAnswer } from "./src/replies.ts";

let id = 0;
function entry(message: object, type = "message"): SessionEntry {
  id += 1;
  // Only the fields the extension reads; the rest of a session entry is irrelevant here.
  return {
    type,
    id: String(id),
    parentId: null,
    timestamp: "",
    message,
  } as unknown as SessionEntry;
}

const user = (text: string) => entry({ role: "user", content: text });
const assistant = (...content: object[]) =>
  entry({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });

test("quotes the agent's latest message without thinking or tool calls", () => {
  assert.equal(
    latestAnswer([
      user("first"),
      assistant(text("Checking.")),
      assistant(
        { type: "thinking", thinking: "hmm" },
        text("Final"),
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
        text("answer."),
      ),
      entry({ role: "toolResult", content: [text("output")] }),
      entry({}, "custom_message"),
    ]),
    "Final\n\nanswer.",
  );
});

test("skips messages without text, such as a turn still thinking", () => {
  assert.equal(
    latestAnswer([
      assistant(text("Answer.")),
      user("next"),
      assistant({ type: "thinking", thinking: "working" }),
    ]),
    "Answer.",
  );
  assert.equal(latestAnswer([user("first")]), undefined);
});
