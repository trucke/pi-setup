import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { QuoteEditor } from "./src/editor.ts";

const plain = (text: string) => text;
const theme: EditorTheme = {
  borderColor: plain,
  selectList: {
    selectedPrefix: plain,
    selectedText: plain,
    description: plain,
    scrollInfo: plain,
    noMatch: plain,
  },
};
const colors = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
// The picker handles its own keys; none of Pi's app actions are bound here.
const keybindings = { matches: () => false } as unknown as KeybindingsManager;
const tui = {
  terminal: { rows: 40, columns: 80 },
  requestRender() {},
} as unknown as TUI;

const blocks = [
  "The cache should use a 24-hour TTL.",
  "- Expire entries nightly",
  "- Keep a backup",
];

const KEYS = {
  up: "\x1b[A",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
};

function type(editor: QuoteEditor, text: string) {
  for (const char of text) editor.handleInput(char);
}

/** The framed rows above the editor's top border. */
function frame(editor: QuoteEditor, width = 80) {
  const lines = editor
    .render(width)
    .map((line) => stripTerminalSequences(line));
  return lines.slice(
    0,
    lines.findIndex((line) => line.startsWith("─")),
  );
}

/** The picker's content rows without their frame. */
function picker(editor: QuoteEditor) {
  return frame(editor)
    .slice(1, -1)
    .map((line) => line.slice(2, -1).trimEnd());
}

const editorWith = () =>
  new QuoteEditor(
    tui,
    theme,
    keybindings,
    () => colors,
    () => blocks,
  );

test("selecting a quote inserts it into the draft", () => {
  const editor = editorWith();
  type(editor, ">");

  assert.equal(editor.pickerOpen, true);
  assert.equal(picker(editor)[2], "› - Keep a backup");

  editor.handleInput(KEYS.enter);
  assert.equal(editor.pickerOpen, false);
  assert.equal(editor.getText(), "> - Keep a backup\n\n");
  assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
});

test("/ filters like vim search: Enter keeps it, Escape clears it", () => {
  const editor = editorWith();
  type(editor, ">/ex");
  assert.deepEqual(picker(editor), ["/ex▏", "› - Expire entries nightly"]);
  editor.handleInput(KEYS.backspace);
  editor.handleInput(KEYS.backspace);
  type(editor, "cache");
  editor.handleInput(KEYS.enter);
  assert.deepEqual(picker(editor), [
    "/cache",
    "› The cache should use a 24-hour TTL.",
  ]);

  type(editor, "/");
  editor.handleInput(KEYS.escape);
  assert.equal(picker(editor).length, blocks.length);
  assert.equal(editor.getText(), ">");
});

test("quotes in the middle of a draft keep the rest", () => {
  const editor = editorWith();
  editor.setText("Intro\n\nOutro");
  editor.handleInput(KEYS.up);
  type(editor, ">g");
  editor.handleInput(KEYS.enter);
  type(editor, "Why?");
  assert.equal(
    editor.getText(),
    "Intro\n\n> The cache should use a 24-hour TTL.\n\nWhy?\nOutro",
  );
});
