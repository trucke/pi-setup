/**
 * Alt+V pastes the clipboard's text into the prompt as a fenced code block.
 *
 * Pi reads the clipboard natively but does not export that reader, so this
 * uses the platform's clipboard commands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { codePaste, trimCode } from "./fence.ts";

const run = promisify(execFile);

type ClipboardCommand = readonly [command: string, args: readonly string[]];

function clipboardCommands(): ClipboardCommand[] {
  if (process.platform === "darwin") return [["pbpaste", []]];
  if (process.platform !== "linux") return [];
  const commands: ClipboardCommand[] = [];
  if (process.env.WAYLAND_DISPLAY) {
    commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
  }
  if (process.env.DISPLAY) {
    commands.push(
      ["xclip", ["-selection", "clipboard", "-out"]],
      ["xsel", ["--clipboard", "--output"]],
    );
  }
  return commands;
}

async function readClipboardText() {
  for (const [command, args] of clipboardCommands()) {
    try {
      const { stdout } = await run(command, args, {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
        // pbpaste mangles non-ASCII text unless the locale says UTF-8.
        env:
          command === "pbpaste"
            ? { ...process.env, LC_CTYPE: "UTF-8" }
            : process.env,
      });
      return stdout;
    } catch {
      // Missing tool or no text on the clipboard: try the next command.
    }
  }
  return undefined;
}

export default function codePasteExtension(pi: ExtensionAPI) {
  pi.registerShortcut(Key.alt("v"), {
    description: "Paste the clipboard as a code block",
    handler: async (ctx) => {
      const text = await readClipboardText();
      if (text === undefined) {
        ctx.ui.notify("Could not read the clipboard", "warning");
        return;
      }
      const code = trimCode(text);
      if (!code) {
        ctx.ui.notify("The clipboard has no text", "info");
        return;
      }
      // Pasting keeps Pi's paste handling, which collapses long blocks.
      ctx.ui.pasteToEditor(codePaste(code, ctx.ui.getEditorText()));
      // Pi redraws after a key press, which happened before the clipboard
      // read finished, and pasteToEditor() does not redraw. Clearing an unset
      // status is invisible but makes Pi redraw the editor.
      ctx.ui.setStatus("code-paste", undefined);
    },
  });
}
