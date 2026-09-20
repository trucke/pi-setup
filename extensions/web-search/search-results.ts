import { sanitizeLine } from "./sanitize.ts";

export const SEARCH_EXCERPT_CHARACTERS = 1200;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > SEARCH_EXCERPT_CHARACTERS
    ? `${text.slice(0, SEARCH_EXCERPT_CHARACTERS)}\n[Excerpt truncated; fetch the source URL for more.]`
    : text;
}

function formatResult(item: Record<string, unknown>, index: number) {
  const title =
    typeof item.title === "string"
      ? item.title.replace(/\s+/g, " ").slice(0, 300)
      : "Untitled";
  const url = typeof item.url === "string" ? item.url : "";
  const date = item.publishedDate ?? item.publishedTime ?? item.date;
  const highlights = Array.isArray(item.highlights)
    ? item.highlights
        .filter((value): value is string => typeof value === "string")
        .join("\n")
    : item.highlights;
  const snippet = [
    highlights,
    item.summary,
    item.description,
    item.text,
    item.markdown,
  ]
    .map(excerpt)
    .find(Boolean);
  return [
    `${index + 1}. ${title}`,
    url,
    typeof date === "string" && date !== "N/A"
      ? `Published: ${date.slice(0, 100)}`
      : "",
    snippet,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Provider envelopes and full-page bodies are not search results. */
export function normalizeSearchResults(text: string, limit: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* Exa's basic search returns labeled text. */
  }
  let items: unknown;
  if (record(parsed)) {
    if (Array.isArray(parsed.results)) items = parsed.results;
    else if (record(parsed.data)) items = parsed.data.web;
    else if (Array.isArray(parsed.data)) items = parsed.data;
  } else if (Array.isArray(parsed)) items = parsed;

  if (!Array.isArray(items) && text.startsWith("Title:")) {
    const blocks = text.split(/\n+(?=Title:)/);
    const labeled = blocks.map((block) => {
      const header = block.match(
        /^Title: ([^\n]*)\nURL: ([^\n]*)\n(?:Published: ([^\n]*)\n)?(?:Author: [^\n]*\n)?(?:Highlights:|Text:)\n([\s\S]*)$/,
      );
      return header
        ? {
            title: header[1],
            url: header[2],
            publishedDate: header[3],
            highlights: header[4],
          }
        : undefined;
    });
    if (labeled.every((item) => item !== undefined)) items = labeled;
  }
  // Keep unfamiliar formats visible rather than silently dropping evidence.
  // The shared inline budget still bounds them.
  if (!Array.isArray(items))
    return { text: text || "No search results returned." };
  const results = items.filter(record).slice(0, limit);
  return {
    text: results.length
      ? results.map(formatResult).join("\n\n")
      : "No search results returned.",
    resultCount: results.length,
    items: results.slice(0, 3).map((item) => ({
      title:
        typeof item.title === "string"
          ? sanitizeLine(item.title).slice(0, 300)
          : "Untitled",
      url:
        typeof item.url === "string"
          ? sanitizeLine(item.url).slice(0, 8192)
          : "",
    })),
  };
}
