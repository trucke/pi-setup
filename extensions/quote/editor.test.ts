import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager as TuiKeybindings,
  setKeybindings,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
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

test("> opens a framed picker above the editor", () => {
  const editor = editorWith();
  type(editor, ">");

  const [top, ...rest] = frame(editor);
  assert.match(top ?? "", /^╭─ Quote the latest answer ─+╮$/);
  assert.match(
    rest.at(-1) ?? "",
    /^╰─ j\/k move · \/ search · enter insert · q close ─+╯$/,
  );
  assert.ok(rest.every((line) => line.length === 80));
  assert.equal(picker(editor)[2], "› - Keep a backup");

  editor.handleInput(KEYS.enter);
  assert.equal(editor.pickerOpen, false);
  assert.equal(editor.getText(), "> - Keep a backup\n\n");
  assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
});

test("j, k, g and G move without typing into the draft", () => {
  const editor = editorWith();
  type(editor, ">kkj");
  assert.equal(picker(editor)[1], "› - Expire entries nightly");
  type(editor, "g");
  assert.equal(picker(editor)[0], "› The cache should use a 24-hour TTL.");
  type(editor, "G");
  assert.equal(picker(editor)[2], "› - Keep a backup");
  assert.equal(editor.getText(), ">");
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

test("q closes the picker until the > line changes", () => {
  const editor = editorWith();
  type(editor, ">q");
  assert.equal(editor.pickerOpen, false);
  editor.handleInput(KEYS.backspace);
  type(editor, ">");
  assert.ok(editor.pickerOpen);
});

test("a space after > writes the user's own quote", () => {
  const editor = editorWith();
  type(editor, "> my own words");
  assert.equal(editor.pickerOpen, false);
  assert.equal(editor.getText(), "> my own words");
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

test("vim keys work when the Kitty keyboard protocol encodes them", () => {
  const editor = editorWith();
  type(editor, ">");
  editor.handleInput("\x1b[107u"); // k
  assert.equal(picker(editor)[1], "› - Expire entries nightly");
  editor.handleInput("\x1b[103:71;2u"); // Shift+G
  assert.equal(picker(editor)[2], "› - Keep a backup");
  assert.equal(editor.getText(), ">");
});

test("removes > even when backspace is bound to another key", (t) => {
  const previous = getKeybindings();
  t.after(() => setKeybindings(previous));
  setKeybindings(
    new TuiKeybindings(TUI_KEYBINDINGS, {
      "tui.editor.deleteCharBackward": "ctrl+h",
    }),
  );

  const editor = editorWith();
  type(editor, ">");
  editor.handleInput(KEYS.enter);
  assert.equal(editor.getText(), "> - Keep a backup\n\n");
});

test("a click closes the picker instead of quoting over moved text", () => {
  const editor = editorWith();
  editor.setText("Intro\nOutro\n");
  type(editor, ">");
  const height = frame(editor).length;
  const click: TuiMouseEvent = {
    type: "click",
    button: "left",
    x: 1,
    y: height + 2,
    screenX: 1,
    screenY: height + 2,
    width: 80,
    height: height + 5,
    shift: false,
    alt: false,
    ctrl: false,
  };
  editor.handleMouse(click);
  assert.equal(editor.pickerOpen, false);
  assert.equal(editor.getText(), "Intro\nOutro\n>");
});

test("shortcuts typed while searching close the picker and reach Pi", () => {
  const editor = editorWith();
  type(editor, ">/");
  editor.handleInput("\x11"); // Ctrl+Q
  assert.equal(editor.pickerOpen, false);
});

test("the panel never exceeds narrow widths", () => {
  const editor = editorWith();
  type(editor, ">");
  for (let width = 1; width <= 12; width++) {
    const panel = frame(editor, width);
    assert.ok(panel.length > 0);
    for (const line of panel) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
});
