import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
  matchesKey,
  truncateToWidth,
  type KeybindingsManager,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

export type PreviewContext = Pick<ExtensionContext, "mode"> & {
  ui: Pick<ExtensionContext["ui"], "custom" | "select">;
};

/** Read-only viewport. Wrapping follows the terminal, never changes the report. */
export class TextPreview {
  private readonly content: Text;
  private offset = 0;
  private contentRows = 0;
  private viewportRows = 1;
  private readonly tui;
  private readonly theme;
  private readonly keys;
  private readonly done;

  constructor(
    text: string,
    tui: { terminal: { rows: number }; requestRender(): void },
    theme: Pick<Theme, "fg" | "bold">,
    keys: KeybindingsManager,
    done: (reviewed: boolean) => void,
  ) {
    this.content = new Text(text, 0, 0);
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
  }

  private scroll(offset: number) {
    this.offset = Math.max(
      0,
      Math.min(offset, this.contentRows - this.viewportRows),
    );
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) this.done(false);
    else if (this.keys.matches(data, "tui.select.confirm")) this.done(true);
    else if (this.keys.matches(data, "tui.select.up"))
      this.scroll(this.offset - 1);
    else if (this.keys.matches(data, "tui.select.down"))
      this.scroll(this.offset + 1);
    else if (this.keys.matches(data, "tui.select.pageUp"))
      this.scroll(this.offset - this.viewportRows);
    else if (this.keys.matches(data, "tui.select.pageDown"))
      this.scroll(this.offset + this.viewportRows);
    else if (matchesKey(data, "home")) this.scroll(0);
    else if (matchesKey(data, "end")) this.scroll(this.contentRows);
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "wheel") return;
    this.scroll(this.offset + (event.wheelDelta ?? 0));
    return { handled: true };
  }

  render(width: number) {
    const lines = this.content.render(width);
    this.contentRows = lines.length;
    // Five chrome rows plus the overlay's top/bottom margin.
    this.viewportRows = Math.max(1, this.tui.terminal.rows - 7);
    this.offset = Math.max(
      0,
      Math.min(this.offset, lines.length - this.viewportRows),
    );
    const end = Math.min(lines.length, this.offset + this.viewportRows);
    const range =
      lines.length > this.viewportRows
        ? `Lines ${this.offset + 1}-${end} of ${lines.length} · ↑↓ / PgUp/PgDn scroll · Home/End`
        : "Full preview";
    const confirm = this.keys.getKeys("tui.select.confirm").join("/");
    const cancel = this.keys.getKeys("tui.select.cancel").join("/");
    return [
      this.theme.fg("accent", this.theme.bold("Review before continuing")),
      "",
      ...lines.slice(this.offset, end),
      "",
      this.theme.fg("dim", range),
      this.theme.fg(
        "muted",
        `${confirm} continue (does not send) · ${cancel} cancel`,
      ),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate() {
    this.content.invalidate();
  }
}

export async function reviewText(
  ctx: PreviewContext,
  text: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (ctx.mode !== "tui") {
    // RPC clients own their presentation. Send the whole document, not pages.
    const choice = await ctx.ui.select(
      `Exact preview:\n${text}`,
      ["No", "Continue review"],
      { signal },
    );
    signal.throwIfAborted();
    return choice === "Continue review";
  }
  let cleanup = () => {};
  try {
    const reviewed = await ctx.ui.custom<boolean>(
      (tui, theme, keys, done) => {
        const onAbort = () => done(false);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        return new TextPreview(text, tui, theme, keys, done);
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          margin: { top: 1, bottom: 1 },
        },
      },
    );
    signal.throwIfAborted();
    return reviewed === true;
  } finally {
    cleanup();
  }
}
