import assert from "node:assert/strict";
import test from "node:test";
import {
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Terminal,
} from "@earendil-works/pi-tui";
import { installUnwrappedCopy, selectionHost } from "./index.ts";

const WIDTH = 30;

/** A terminal that records nothing and lets the test type mouse input. */
function fakeTerminal() {
  let onInput: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    start(input) {
      onInput = input;
    },
    stop() {
      onInput = undefined;
    },
    async drainInput() {},
    write() {},
    columns: WIDTH,
    rows: 10,
    kittyProtocolActive: true,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
  return { terminal, send: (data: string) => onInput?.(data) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Drags across the transcript from its first to its last cell and returns the copied text. */
async function copyTranscript(text: string) {
  const { terminal, send } = fakeTerminal();
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copySelection: async (selection) => {
      copied.push(selection);
      return true;
    },
  });
  tui.setLayoutRoot(
    new VStack([
      {
        component: new ScrollView(new Text(text, 0, 0)),
        basis: 0,
        grow: 1,
      },
    ]),
  );
  tui.start();
  await settle();
  send("\x1b[<0;1;1M");
  send(`\x1b[<32;${WIDTH};4M`);
  send(`\x1b[<0;${WIDTH};4m`);
  await settle();
  tui.stop();
  return copied.at(-1);
}

const sentence =
  "Pi wraps this sentence across several rows of the transcript.";

test("Pi's private selection hooks still exist", () => {
  const host = selectionHost();
  assert.equal(typeof host.getActiveSelectionText, "function");
  assert.equal(typeof host.getSelectionBounds, "function");
});

test("copies a dragged selection without wrap line breaks", async () => {
  assert.match((await copyTranscript(sentence)) ?? "", /\n/);

  const restore = installUnwrappedCopy(() => 0);
  try {
    // A reloaded extension must not wrap the patched method again.
    const patched = selectionHost().getActiveSelectionText;
    installUnwrappedCopy(() => 0)();
    assert.equal(selectionHost().getActiveSelectionText, patched);
    assert.equal(await copyTranscript(sentence), sentence);
  } finally {
    restore();
  }
  assert.match((await copyTranscript(sentence)) ?? "", /\n/);
});
