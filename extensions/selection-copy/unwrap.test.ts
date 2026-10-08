import assert from "node:assert/strict";
import test from "node:test";
import {
  Markdown,
  stripTerminalSequences,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { unwrapSelection } from "./unwrap.ts";

const plain = (text: string) => text;
const theme: MarkdownTheme = {
  heading: plain,
  link: plain,
  linkUrl: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  quote: plain,
  quoteBorder: plain,
  hr: plain,
  listBullet: plain,
  bold: plain,
  italic: plain,
  strikethrough: plain,
  underline: plain,
};

/** What Pi copies today: the rendered rows as plain text, trimmed and joined with newlines. */
function selectAll(markdown: string, width: number, pad = 0) {
  return new Markdown(markdown, pad, 0, theme)
    .render(width)
    .map((row) => stripTerminalSequences(row).trimEnd())
    .join("\n");
}

function unwrap(markdown: string, width: number, pad = 0) {
  return unwrapSelection(selectAll(markdown, width, pad), {
    width,
    rightPad: pad,
    firstColumn: 0,
  });
}

test("joins prose that Pi wrapped to the screen width", () => {
  const sentence =
    "Classio sends school announcements to parents and keeps the timetable in sync.";
  assert.notEqual(selectAll(sentence, 24), sentence);
  assert.equal(unwrap(sentence, 24), sentence);
  assert.equal(unwrap(sentence, 30, 1), ` ${sentence}`);
});

test("keeps real line breaks, paragraphs and list items", () => {
  const markdown = [
    "Short line.  ",
    "Next line.",
    "",
    "- first item that is long enough to wrap",
    "- second item",
  ].join("\n");

  assert.equal(
    unwrap(markdown, 24),
    [
      "Short line.",
      "Next line.",
      "",
      "- first item that is long enough to wrap",
      "- second item",
    ].join("\n"),
  );
});

test("joins quotes without repeating their bars", () => {
  assert.equal(
    unwrap("> a quote that is long enough to wrap around the edge", 24),
    "│ a quote that is long enough to wrap around the edge",
  );
});

test("keeps table rows apart", () => {
  const table = "| Step | Owner |\n|---|---|\n| Build | CI |";
  assert.equal(unwrap(table, 24), selectAll(table, 24));
});

test("joins a word split across rows without adding spaces", () => {
  const url = "see https://example.com/a/very/long/path/that/cannot/fit";
  assert.equal(unwrap(url, 20), url);
});

test("counts unselected columns of the first row", () => {
  const rows = "wraps here\nand continues";
  assert.equal(
    unwrapSelection(rows, { width: 24, rightPad: 0, firstColumn: 14 }),
    "wraps here and continues",
  );
  assert.equal(
    unwrapSelection(rows, { width: 24, rightPad: 0, firstColumn: 0 }),
    rows,
  );
});
