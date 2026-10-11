import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  blockquote,
  isQuoteTrigger,
  matchingBlocks,
  quoteInsertion,
} from "./blocks.ts";

interface Picker {
  readonly blocks: readonly string[];
  selected: number;
  search: string;
  searching: boolean;
}

const VISIBLE_ROWS = 8;
/**
 * Pi's Editor deletes on Shift+Backspace regardless of the user's backspace
 * binding, so removing the `>` cannot type a DEL character instead.
 */
const SHIFT_BACKSPACE = "\x1b[127;2u";
const graphemes = new Intl.Segmenter();

/** A typed character, also when the Kitty keyboard protocol encodes it. */
function printable(data: string) {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  return /^[^\x00-\x1f\x7f]$/u.test(data) ? data : undefined;
}

function pad(text: string, width: number) {
  const cut = truncateToWidth(text, width, "…");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * Pi's editor with a quote picker above it. Typing `>` on an empty line opens
 * the latest answer's paragraphs; the picker then takes vim-style keys until
 * it inserts a quote or closes.
 */
export class QuoteEditor extends CustomEditor {
  private readonly colors: () => Theme;
  private readonly loadBlocks: () => string[];
  private picker: Picker | undefined;
  /** Rows drawn above the editor, which mouse events must skip. */
  private pickerHeight = 0;
  /** A closed picker stays closed until the `>` line changes. */
  private dismissed = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    colors: () => Theme,
    loadBlocks: () => string[],
  ) {
    super(tui, theme, keybindings);
    this.colors = colors;
    this.loadBlocks = loadBlocks;
  }

  get pickerOpen() {
    return this.picker !== undefined;
  }

  /** Inserts a block quote at the cursor, separated from surrounding text. */
  insertQuote(text: string) {
    this.insertTextAtCursor(
      quoteInsertion(blockquote(text), {
        lines: this.getLines(),
        cursor: this.getCursor(),
      }),
    );
  }

  override handleInput(data: string) {
    const picker = this.picker;
    if (picker) {
      const handled = picker.searching
        ? this.handleSearchKey(picker, data)
        : this.handleNormalKey(picker, data);
      this.tui.requestRender();
      if (handled) return;
      // Any other key closes the picker and reaches the editor, so `> ` still
      // starts a quote the user writes.
      this.close();
    }
    super.handleInput(data);
    this.openFromTrigger();
  }

  override render(width: number) {
    const editor = super.render(width);
    const picker = this.picker ? this.renderPicker(this.picker, width) : [];
    this.pickerHeight = picker.length;
    return [...picker, ...editor];
  }

  override handleMouse(event: TuiMouseEvent) {
    if (event.y < this.pickerHeight) return { handled: true };
    // A click moves the cursor away from the `>` the picker replaces.
    if (this.picker && (event.type === "press" || event.type === "click")) {
      this.close();
    }
    return super.handleMouse({
      ...event,
      y: event.y - this.pickerHeight,
      height: event.height - this.pickerHeight,
    });
  }

  private close() {
    this.dismissed = true;
    this.picker = undefined;
  }

  private openFromTrigger() {
    const trigger =
      !this.isShowingAutocomplete() &&
      isQuoteTrigger({ lines: this.getLines(), cursor: this.getCursor() });
    if (!trigger) {
      this.dismissed = false;
      return;
    }
    if (this.dismissed || this.picker) return;
    const blocks = this.loadBlocks();
    if (blocks.length === 0) return;
    this.picker = { blocks, selected: 0, search: "", searching: false };
    this.selectLast(this.picker);
  }

  private matches(picker: Picker) {
    return matchingBlocks(
      picker.blocks.map((text) => ({ text })),
      picker.search,
    ).map(({ text }) => text);
  }

  /** The last block sits next to the editor and usually concludes the answer. */
  private selectLast(picker: Picker) {
    this.move(picker, Number.MAX_SAFE_INTEGER);
  }

  private move(picker: Picker, to: number) {
    const last = this.matches(picker).length - 1;
    picker.selected = Math.max(0, Math.min(last, to));
  }

  private handleNormalKey(picker: Picker, data: string) {
    const half = Math.floor(VISIBLE_ROWS / 2);
    const char = printable(data);
    if (char === "j" || matchesKey(data, Key.down)) {
      this.move(picker, picker.selected + 1);
    } else if (char === "k" || matchesKey(data, Key.up)) {
      this.move(picker, picker.selected - 1);
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.move(picker, picker.selected + half);
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.move(picker, picker.selected - half);
    } else if (char === "g") {
      this.move(picker, 0);
    } else if (char === "G") {
      this.selectLast(picker);
    } else if (char === "/") {
      picker.searching = true;
    } else if (matchesKey(data, Key.enter)) {
      this.choose(picker);
    } else if (char === "q" || matchesKey(data, Key.escape)) {
      this.close();
    } else {
      return false;
    }
    return true;
  }

  /** Like vim's `/`: Enter keeps the filter, Escape clears it. */
  private handleSearchKey(picker: Picker, data: string) {
    if (matchesKey(data, Key.enter)) {
      picker.searching = false;
    } else if (matchesKey(data, Key.escape)) {
      picker.searching = false;
      picker.search = "";
      this.selectLast(picker);
    } else if (matchesKey(data, Key.backspace)) {
      if (!picker.search) picker.searching = false;
      picker.search = [...graphemes.segment(picker.search)]
        .slice(0, -1)
        .map(({ segment }) => segment)
        .join("");
      this.selectLast(picker);
    } else if (matchesKey(data, Key.down) || matchesKey(data, Key.up)) {
      this.move(
        picker,
        picker.selected + (matchesKey(data, Key.down) ? 1 : -1),
      );
    } else {
      const char = printable(data);
      // Shortcuts close the picker and reach the editor and Pi as usual.
      if (char === undefined) return false;
      picker.search += char;
      this.selectLast(picker);
    }
    return true;
  }

  private choose(picker: Picker) {
    const block = this.matches(picker)[picker.selected];
    if (block === undefined) return;
    this.picker = undefined;
    if (!isQuoteTrigger({ lines: this.getLines(), cursor: this.getCursor() }))
      return;
    // Pi's editor cannot replace text before the cursor, and setText() would
    // drop collapsed pastes elsewhere in the draft, so one deletion removes `>`.
    // It bypasses CustomEditor so no app action can claim the key.
    Editor.prototype.handleInput.call(this, SHIFT_BACKSPACE);
    this.insertQuote(block);
  }

  /** A framed panel in the accent color, so selecting is clearly its own mode. */
  private renderPicker(picker: Picker, width: number) {
    const theme = this.colors();
    const border = (text: string) => theme.fg("borderAccent", text);
    const inner = Math.max(1, width - 4);
    const edge = (left: string, label: string, right: string) => {
      const text = label ? `─ ${label} ` : "";
      const fill = Math.max(0, width - 2 - visibleWidth(text));
      return truncateToWidth(
        border(left) + border(text) + border("─".repeat(fill)) + border(right),
        width,
        "",
      );
    };
    const row = (content: string, background?: (text: string) => string) => {
      const cell = ` ${pad(content, inner)} `;
      return border("│") + (background ? background(cell) : cell) + border("│");
    };

    const rows = [
      edge("╭", theme.fg("accent", theme.bold("Quote the latest answer")), "╮"),
    ];
    if (picker.searching || picker.search) {
      const cursor = picker.searching ? theme.fg("accent", "▏") : "";
      rows.push(row(theme.fg("accent", "/") + picker.search + cursor));
    }

    const found = this.matches(picker);
    if (found.length === 0) rows.push(row(theme.fg("muted", "No matches")));
    const start = Math.max(
      0,
      Math.min(
        picker.selected - Math.floor(VISIBLE_ROWS / 2),
        found.length - VISIBLE_ROWS,
      ),
    );
    for (const [offset, block] of found
      .slice(start, start + VISIBLE_ROWS)
      .entries()) {
      const label = block.replace(/\s+/g, " ");
      rows.push(
        start + offset === picker.selected
          ? row(theme.fg("accent", "› ") + theme.bold(label), (text) =>
              theme.bg("selectedBg", text),
            )
          : row(`  ${theme.fg("muted", label)}`),
      );
    }

    const position =
      found.length > VISIBLE_ROWS
        ? ` · ${picker.selected + 1}/${found.length}`
        : "";
    const keys = picker.searching
      ? "type to filter · enter keep · esc clear"
      : "j/k move · / search · enter insert · q close";
    rows.push(edge("╰", theme.fg("dim", keys + position), "╯"));
    // Below five columns the frame cannot fit; Pi rejects wider lines.
    return rows.map((line) => truncateToWidth(line, width, ""));
  }
}
