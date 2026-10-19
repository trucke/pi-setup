import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import quote from "./index.ts";

type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;
type Handler = (event: unknown, ctx: ExtensionContext) => void;

/** Loads the extension against a fake Pi that records editors and the draft. */
function load() {
  const handlers = new Map<string, Handler>();
  const shortcuts: ((ctx: ExtensionContext) => unknown)[] = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerShortcut: (
      _key: string,
      options: { handler: (ctx: ExtensionContext) => unknown },
    ) => shortcuts.push(options.handler),
    registerCommand() {},
  } as unknown as ExtensionAPI;
  quote(pi);

  const state = { factory: undefined as EditorFactory | undefined, draft: "" };
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => state.factory,
      setEditorComponent: (next: EditorFactory | undefined) => {
        state.factory = next;
      },
      getEditorText: () => state.draft,
      setEditorText: (text: string) => {
        state.draft = text;
      },
      notify() {},
    },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Answer." }],
          },
        },
      ],
    },
  } as unknown as ExtensionContext;

  const emit = (event: string) => handlers.get(event)?.({}, ctx);
  const quoteLatest = () => shortcuts[0]?.(ctx);
  return { state, emit, quoteLatest };
}

const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
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
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

test("quotes into the visible editor after another extension replaces it", () => {
  const { state, emit, quoteLatest } = load();
  emit("session_start");
  const ours = state.factory;
  assert.ok(ours);
  ours(tui, theme, keybindings);

  const theirs: EditorFactory = (...args) => ours(...args);
  state.factory = theirs;
  quoteLatest();
  assert.equal(state.draft, "> Answer.\n\n");

  emit("session_shutdown");
  assert.equal(state.factory, theirs);
});
