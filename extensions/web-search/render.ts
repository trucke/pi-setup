import {
  keyHint,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { sanitizeLine, sanitizeText } from "./sanitize.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function size(bytes: number) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}
function line(value: unknown) {
  return typeof value === "string" ? sanitizeLine(value) : "";
}

const renderResult: NonNullable<
  ToolDefinition<TSchema, unknown, unknown>["renderResult"]
> = (result, { expanded, isPartial }, theme, context) => {
  const output = sanitizeText(
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  );
  const details = record(result.details) ? result.details : {};
  const args = record(context.args) ? context.args : {};
  const text = new Text(
    output || (isPartial ? "Working…" : "No output."),
    0,
    0,
  );
  // Card metadata comes from tool-authored details only. The output text holds
  // page content, which can imitate the truncation notice or a Coverage line.
  const provider = line(details.provider) || "Result";
  const path = line(details.savedPath);
  const providerLabel =
    (
      {
        exa: "Exa",
        firecrawl: "Firecrawl",
        local: "Local",
        "firecrawl-developer": "Firecrawl Developer Index",
      } as Record<string, string>
    )[provider] ?? provider;
  const status = [providerLabel];
  if (line(details.auth)) status.push(line(details.auth));
  if (typeof details.resultCount === "number")
    status.push(`${details.resultCount} results`);
  status.push(`${size(Buffer.byteLength(output))} shown`);
  if (path)
    status.push(
      typeof details.contentBytes === "number"
        ? `${size(details.contentBytes)} total · saved`
        : "full output saved",
    );
  const summary = [status.join(" · ")];
  const filters = [
    Array.isArray(args.includeDomains)
      ? args.includeDomains.map(line).filter(Boolean).join(", ")
      : "",
    Array.isArray(args.repos)
      ? args.repos.map(line).filter(Boolean).join(", ")
      : "",
    Array.isArray(args.excludeDomains) && args.excludeDomains.length
      ? `excluding ${args.excludeDomains.map(line).filter(Boolean).join(", ")}`
      : "",
    line(args.recency) ? `past ${line(args.recency)}` : "",
  ].filter(Boolean);
  if (filters.length) summary.push(`Scope: ${filters.join(" · ")}`);
  if (Array.isArray(details.repos)) {
    for (const repo of details.repos.slice(0, 1)) {
      if (
        record(repo) &&
        line(repo.canonicalRepo) &&
        repo.canonicalRepo !== repo.repo
      )
        summary.push(
          `${line(repo.repo)} → ${line(repo.canonicalRepo)}${repo.indexed === true ? " (indexed)" : ""}`,
        );
    }
  }
  if (Array.isArray(details.items)) {
    for (const item of details.items.slice(0, 3)) {
      if (record(item)) summary.push(`${line(item.title)} · ${line(item.url)}`);
    }
  } else {
    if (line(details.title)) summary.push(line(details.title));
    const source = line(details.url) || line(args.url);
    if (source) summary.push(source);
    const body = output
      .split(/\n\n/)
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // JSON is useful expanded, but a page summary should not show serialized envelopes.
    if (body && !/^[{[]/.test(body))
      summary.push(`Excerpt: ${body.slice(0, 240)}`);
  }
  if (provider === "firecrawl-developer")
    summary.push(
      `Coverage: ${
        record(details.coverage)
          ? Object.entries(details.coverage)
              .map(([type, state]) => `${type} ${line(state)}`)
              .join(" · ")
          : "not reported"
      }`,
    );
  if (line(details.fallbackReason))
    summary.splice(1, 0, `Fallback: ${line(details.fallbackReason)}`);
  if (path) summary.push(`Saved: ${path}`);

  return {
    invalidate: () => text.invalidate(),
    render(width: number) {
      if (context.isError || isPartial) {
        const rows = text.render(width);
        const shown = expanded ? rows : rows.slice(0, 6);
        return [
          ...shown.map((row) =>
            theme.fg(context.isError ? "error" : "muted", row),
          ),
          ...(!expanded && rows.length > 6
            ? [truncateToWidth(keyHint("app.tools.expand", "to expand"), width)]
            : []),
        ];
      }
      const header = theme.fg(
        "accent",
        `${expanded ? "▾" : "▸"} ${summary[0]}`,
      );
      if (expanded)
        return [
          truncateToWidth(header, width),
          ...text.render(width).map((row) => theme.fg("toolOutput", row)),
        ];
      return [
        truncateToWidth(header, width),
        ...summary
          .slice(1, 6)
          .map((row) => truncateToWidth(theme.fg("muted", `  ${row}`), width)),
        truncateToWidth(
          keyHint("app.tools.expand", "to expand details"),
          width,
        ),
      ];
    },
  };
};

export function webRenderers(name: string) {
  return {
    renderCall(
      args: { query?: string; url?: string; provider?: string },
      theme: Theme,
    ) {
      const target = line(args.query ?? args.url);
      return {
        invalidate() {},
        render: (width: number) => [
          truncateToWidth(
            theme.fg("toolTitle", theme.bold(name)) +
              (target ? ` ${target}` : ""),
            width,
          ),
        ],
      };
    },
    renderResult,
  };
}
