import { visibleWidth } from "@earendil-works/pi-tui";

export interface WrapGeometry {
  /** Columns the transcript renders into. */
  readonly width: number;
  /** Pi's `outputPad`: text wraps this many columns before the right edge. */
  readonly rightPad: number;
  /** Column where the selection starts; the first row's earlier columns are not in the text. */
  readonly firstColumn: number;
}

/** Tables, rules and code frames end in box-drawing characters and never wrap into prose. */
const BOX_DRAWING_END = /[\u2500-\u257f]\s*$/;
const LIST_ITEM = /^(?:[-*+•]|\d+[.)])\s/;
/** Quote bars that Pi repeats on every wrapped row of a block quote. */
const QUOTE_PREFIX = /^\s*(?:│ ?)+/;

/** The next row without the indentation or quote bars repeated from the wrapped row. */
function continuation(previous: string, next: string) {
  const quote = QUOTE_PREFIX.exec(previous)?.[0];
  const rest =
    quote && next.startsWith(quote) ? next.slice(quote.length) : next;
  return rest.trimStart();
}

/**
 * Pi wraps greedily at spaces, so a row ended at a wrap exactly when the next
 * row's first word would not have fit after it. A shorter row ended at a real
 * line break in the source text.
 */
function isWrap(
  previous: string,
  previousWidth: number,
  next: string,
  limit: number,
) {
  if (!previous.trim() || !next.trim()) return false;
  if (BOX_DRAWING_END.test(previous) || BOX_DRAWING_END.test(next)) {
    return false;
  }
  const rest = continuation(previous, next);
  if (LIST_ITEM.test(rest)) return false;
  const firstWord = rest.split(/\s/, 1)[0] ?? "";
  return previousWidth + 1 + visibleWidth(firstWord) > limit;
}

/**
 * A word longer than the row is split mid-word: the row is one token that
 * fills it. Every other wrap replaced a space.
 */
function separator(previous: string, previousWidth: number, limit: number) {
  const content = previous.replace(QUOTE_PREFIX, "").trim();
  return previousWidth >= limit && !/\s/.test(content) ? "" : " ";
}

/** Join rows that Pi wrapped to fit the screen, keeping real line breaks. */
export function unwrapSelection(text: string, geometry: WrapGeometry) {
  const rows = text.split("\n");
  const limit = geometry.width - geometry.rightPad;
  let result = rows[0] ?? "";
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1] ?? "";
    const next = rows[index] ?? "";
    const previousWidth =
      visibleWidth(previous) + (index === 1 ? geometry.firstColumn : 0);
    result += isWrap(previous, previousWidth, next, limit)
      ? separator(previous, previousWidth, limit) + continuation(previous, next)
      : `\n${next}`;
  }
  return result;
}
