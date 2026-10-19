/** Clipboard text without the blank lines and trailing whitespace around it. */
export function trimCode(text: string) {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

/**
 * Fences code with more backticks than any run inside it, so pasted Markdown
 * that contains its own fences cannot close the block early.
 */
export function codeBlock(code: string) {
  const longest = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), ([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${code}\n${fence}`;
}

/**
 * Text to paste so the code block starts and ends its own paragraph. Pi does
 * not expose the cursor to extensions, so this assumes it sits at the end of
 * the draft; elsewhere the worst case is an extra blank line.
 */
export function codePaste(code: string, draft: string) {
  const end = draft.replace(/[ \t]+$/, "");
  const lead = !end.trim()
    ? ""
    : end.endsWith("\n\n")
      ? ""
      : end.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${lead}${codeBlock(code)}\n\n`;
}
