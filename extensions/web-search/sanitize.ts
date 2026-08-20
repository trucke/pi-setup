// Queries, titles, excerpts, and page content are model/web-controlled
// strings rendered in the TUI: strip ANSI/CSI/OSC sequences and other control
// characters so they cannot inject terminal commands or desync the renderer.
// Same patterns as background-terminals' output sanitizer.
const TERMINAL_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Multi-line safe: keeps newlines and tabs for Markdown content. */
export function sanitizeText(text: string) {
  return text.replace(TERMINAL_CONTROL_PATTERN, "");
}

/** Single-line variant for fixed-height call/header rendering. */
export function sanitizeLine(text: string) {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
