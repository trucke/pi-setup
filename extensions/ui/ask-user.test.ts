import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { askUserRow } from "./ask-user.ts";
import type { ToolResult } from "./tool-rows.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function detail(details: unknown) {
  const result: ToolResult = { content: [], details };
  return askUserRow.summarize?.(result, theme).detail;
}

test("summarizes chosen, written, multi-select and batched answers", () => {
  assert.equal(
    detail({ answers: [{ label: "Q", answer: "Yes", wasCustom: false }] }),
    "Yes",
  );
  assert.equal(
    detail({
      answers: [{ label: "Q", answer: "Only\nCaddy", wasCustom: true }],
    }),
    "✎ Only Caddy",
  );
  assert.equal(
    detail({
      answers: [{ label: "Q", answer: "Docs", selected: ["Small", "Large"] }],
    }),
    "Small, Large, ✎ Docs",
  );
  assert.equal(
    detail({
      answers: [
        { label: "Scope", answer: "Small", wasCustom: false },
        { label: "Priority", answer: "Soon", wasCustom: true },
      ],
    }),
    "Scope: Small; Priority: ✎ Soon",
  );
});

test("marks dismissed questionnaires and reads legacy results", () => {
  assert.equal(detail({ answers: [], cancelled: true }), "dismissed");
  assert.equal(
    detail({ answer: "Mine", wasCustom: true, cancelled: false }),
    "✎ Mine",
  );
});
