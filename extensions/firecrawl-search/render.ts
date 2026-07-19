import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

interface SearchItemView {
  kind: "web" | "news" | "images";
  title: string;
  url: string;
  description: string;
}

export interface DocumentView {
  title: string;
  url: string;
  description: string;
  markdown: string;
  statusCode?: number;
  creditsUsed?: number;
}

export interface CrawlView {
  id: string;
  status: string;
  completed: number;
  total: number;
  creditsUsed?: number;
  documents: DocumentView[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function displayUrl(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}

export function searchItems(value: unknown): SearchItemView[] {
  const data = record(value);
  if (!data) return [];

  const items: SearchItemView[] = [];
  for (const kind of ["web", "news", "images"] as const) {
    const group = data[kind];
    if (!Array.isArray(group)) continue;

    for (const candidate of group) {
      const item = record(candidate);
      if (!item) continue;
      const metadata = record(item.metadata);
      const url = firstString(
        item.url,
        metadata?.sourceURL,
        metadata?.url,
        item.imageUrl,
      );
      items.push({
        kind,
        title: firstString(item.title, metadata?.title, url, "Untitled result"),
        url,
        description: oneLine(
          firstString(
            item.description,
            item.snippet,
            metadata?.description,
            metadata?.ogDescription,
          ),
        ),
      });
    }
  }

  return items;
}

export function documentView(value: unknown): DocumentView {
  const document = record(value) ?? {};
  const metadata = record(document.metadata) ?? {};
  const url = firstString(metadata.sourceURL, metadata.url, metadata.ogUrl);

  return {
    title: firstString(metadata.title, metadata.ogTitle, url, "Untitled page"),
    url,
    description: oneLine(
      firstString(metadata.description, metadata.ogDescription),
    ),
    markdown: stringValue(document.markdown),
    statusCode: numberValue(metadata.statusCode),
    creditsUsed: numberValue(metadata.creditsUsed),
  };
}

export function crawlView(value: unknown): CrawlView {
  const crawl = record(value) ?? {};
  const data = Array.isArray(crawl.data) ? crawl.data : [];

  return {
    id: stringValue(crawl.id),
    status: firstString(crawl.status, "unknown"),
    completed: numberValue(crawl.completed) ?? data.length,
    total: numberValue(crawl.total) ?? data.length,
    creditsUsed: numberValue(crawl.creditsUsed),
    documents: data.map(documentView),
  };
}

export function boundedMarkdown(markdown: string) {
  return truncateHead(markdown, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
}

export function crawlMarkdown(documents: DocumentView[]) {
  const markdown = documents
    .map((document, index) => {
      const heading = `## ${index + 1}. ${document.title}`;
      const source = document.url ? `\n\nSource: ${document.url}` : "";
      const content = document.markdown
        ? `\n\n${document.markdown}`
        : "\n\n_No Markdown content returned._";
      return `${heading}${source}${content}`;
    })
    .join("\n\n---\n\n");

  return boundedMarkdown(markdown);
}
