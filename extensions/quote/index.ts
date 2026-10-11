/**
 * Quote the agent's latest answer into the prompt editor.
 *
 * - `>` on an empty line picks a paragraph, list item or code block.
 * - Ctrl+Q and `/quote` quote the whole answer.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { blockquote, quotableBlocks } from "./src/blocks.ts";
import { QuoteEditor } from "./src/editor.ts";
import { latestAnswer } from "./src/replies.ts";

type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;

export default function quote(pi: ExtensionAPI) {
  let editor: QuoteEditor | undefined;
  let factory: EditorFactory | undefined;

  /**
   * Another extension can replace the editor later without telling this one,
   * so the quote editor is used only while Pi still shows this factory.
   */
  const ownsEditor = (ctx: ExtensionContext) =>
    factory !== undefined && ctx.ui.getEditorComponent() === factory;
  const activeEditor = (ctx: ExtensionContext) =>
    ownsEditor(ctx) ? editor : undefined;

  const quoteLatest = (ctx: ExtensionContext) => {
    const answer = latestAnswer(ctx.sessionManager.getBranch());
    if (!answer) {
      ctx.ui.notify("No answer to quote yet", "info");
      return;
    }
    const active = activeEditor(ctx);
    if (active) {
      active.insertQuote(answer);
      return;
    }
    // Another extension owns the editor: append instead of inserting at the cursor.
    const draft = ctx.ui.getEditorText().trimEnd();
    const quoted = blockquote(answer);
    ctx.ui.setEditorText(draft ? `${draft}\n\n${quoted}\n\n` : `${quoted}\n\n`);
  };

  pi.on("session_start", (_event, ctx) => {
    editor = undefined;
    factory = undefined;
    if (ctx.mode !== "tui" || ctx.ui.getEditorComponent()) return;
    factory = (tui, theme, keybindings) => {
      editor = new QuoteEditor(
        tui,
        theme,
        keybindings,
        () => ctx.ui.theme,
        () =>
          quotableBlocks(latestAnswer(ctx.sessionManager.getBranch()) ?? ""),
      );
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ownsEditor(ctx)) ctx.ui.setEditorComponent(undefined);
    factory = undefined;
    editor = undefined;
  });

  pi.registerShortcut(Key.ctrl("q"), {
    description: "Quote the latest answer",
    handler: quoteLatest,
  });

  pi.registerCommand("quote", {
    description: "Quote the latest answer",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/quote requires the interactive TUI", "warning");
        return;
      }
      quoteLatest(ctx);
    },
  });
}
