import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";

const markdown = new Marked();

function isList(token: Token): token is Tokens.List {
  return token.type === "list";
}

/**
 * Removes blank lines around a block. Unlike trim(), it keeps the first line's
 * indentation (an indented code block) and trailing spaces (a hard break).
 */
export function stripBlankLines(text: string) {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

/**
 * Splits Markdown into the units a reader quotes: paragraphs, headings and
 * single list items. Code blocks, tables and block quotes stay whole.
 */
export function quotableBlocks(text: string): string[] {
  return markdown
    .lexer(text)
    .flatMap((token) => {
      if (isList(token)) return token.items.map((item) => item.raw);
      if (token.type === "space" || token.type === "hr" || token.type === "def")
        return [];
      return [token.raw];
    })
    .map(stripBlankLines)
    .filter((block) => block.trim());
}

/** Prefixes every line with `> `, so Markdown renders the text as a block quote. */
export function blockquote(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** Blocks containing every word of the search, case-insensitively. */
export function matchingBlocks<T extends { readonly text: string }>(
  blocks: readonly T[],
  search: string,
): T[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return blocks.filter((block) => {
    const text = block.text.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A closing fence has no info string, only optional trailing spaces. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Whether `lineIndex` lies inside a fenced code block of the draft. */
function insideFence(lines: readonly string[], lineIndex: number) {
  let open: string | undefined;
  for (const line of lines.slice(0, lineIndex)) {
    if (!open) {
      open = OPENING_FENCE.exec(line)?.[1];
      continue;
    }
    const fence = CLOSING_FENCE.exec(line)?.[1];
    if (fence && fence[0] === open[0] && fence.length >= open.length)
      open = undefined;
  }
  return open !== undefined;
}

export interface DraftState {
  readonly lines: readonly string[];
  readonly cursor: { readonly line: number; readonly col: number };
}

/**
 * Whether the cursor ends a line holding only `>`, which opens the picker.
 * `> ` with a space starts a quote the user writes; shell commands and code
 * blocks never open it.
 */
export function isQuoteTrigger({ lines, cursor }: DraftState) {
  const line = lines[cursor.line] ?? "";
  if (line !== ">" || cursor.col !== line.length) return false;
  if (lines[0]?.startsWith("!")) return false;
  return !insideFence(lines, cursor.line);
}

/** Text to insert at the cursor so a quote starts and ends its own block. */
export function quoteInsertion(quote: string, { lines, cursor }: DraftState) {
  const before = (lines[cursor.line] ?? "").slice(0, cursor.col);
  const previous = cursor.line > 0 ? lines[cursor.line - 1] : undefined;
  const lead = before.trim() ? "\n\n" : previous?.trim() ? "\n" : "";
  return `${lead}${quote}\n\n`;
}
