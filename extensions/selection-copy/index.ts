/**
 * Copies fullscreen mouse selections without the line breaks Pi inserts where
 * it wrapped text to the screen width.
 *
 * Pi renders wrapped text as separate rows and does not record which row
 * breaks were wraps, so this patches its private selection method and decides
 * from the row widths (see unwrap.ts). If Pi renames that method, copying
 * falls back to Pi's own behavior and index.test.ts fails.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ScrollView,
  type Terminal,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { unwrapSelection } from "./unwrap.ts";

interface SelectionPoint {
  readonly row: number;
  readonly col: number;
  readonly scrollView?: ScrollView;
}

/** The private TuiAltScreen members this extension relies on. */
export interface SelectionHost {
  readonly terminal: Terminal;
  getSelectionBounds():
    | { readonly start: SelectionPoint; readonly end: SelectionPoint }
    | undefined;
  getActiveSelectionText(): string | undefined;
}

type SelectionText = SelectionHost["getActiveSelectionText"];

/** Marks the patched method so a reloaded copy of this module does not wrap it twice. */
const PATCHED = Symbol.for("pi-setup.selection-copy");

export function selectionHost(): Partial<SelectionHost> {
  // Private members are not part of TuiAltScreen's type.
  return TuiAltScreen.prototype as unknown as Partial<SelectionHost>;
}

/** Installs the unwrapping copy; returns a function that restores Pi's method. */
export function installUnwrappedCopy(rightPad: () => number) {
  const host = selectionHost();
  const original = host.getActiveSelectionText;
  if (
    typeof original !== "function" ||
    typeof host.getSelectionBounds !== "function" ||
    PATCHED in original
  ) {
    return () => {};
  }

  const patched: SelectionText = function (this: SelectionHost) {
    const text = original.call(this);
    const start = this.getSelectionBounds()?.start;
    // Only transcript text wraps to the scroll view's width; leave panels alone.
    if (text === undefined || !start?.scrollView) return text;
    return unwrapSelection(text, {
      width: start.scrollView.getContentWidth(this.terminal.columns),
      rightPad: rightPad(),
      firstColumn: start.col,
    });
  };
  Object.defineProperty(patched, PATCHED, { value: true });
  host.getActiveSelectionText = patched;

  return () => {
    if (host.getActiveSelectionText === patched) {
      host.getActiveSelectionText = original;
    }
  };
}

export default function selectionCopy(pi: ExtensionAPI) {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    if (ctx.mode !== "tui") return;
    restore = installUnwrappedCopy(() => pi.getSettings().outputPad ?? 1);
  });

  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
