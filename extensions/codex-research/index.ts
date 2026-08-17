import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  keyHint,
  truncateHead,
  type AgentToolResult,
  type ExecResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  RESEARCH_PARAMETER_DESCRIPTIONS,
  RESEARCH_PROMPT_GUIDELINES,
  RESEARCH_PROMPT_SNIPPET,
  RESEARCH_TOOL_DESCRIPTION,
  researchPrompt,
} from "./prompt.ts";

export const DEFAULT_MAX_SOURCES = 5;
export const MAX_SOURCES_LIMIT = 10;
export const CODEX_TIMEOUT_MS = 300 * 1_000;

type CommandExecutor = Pick<ExtensionAPI, "exec">;

export interface ResearchSource {
  title: string;
  url: string;
}

export interface ResearchResult {
  answer: string;
  sources: ResearchSource[];
}

/** Persisted in tool results so transcripts can be analyzed later. */
export interface ResearchDetails {
  provider: "codex";
  durationMs: number;
  sourceCount: number;
  success: true;
  sources: ResearchSource[];
}

/** Final-response shape passed to `codex exec --output-schema`. */
export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Concise Markdown answer to the research question.",
    },
    sources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["title", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "sources"],
  additionalProperties: false,
};

export function buildCodexArgs(options: {
  query: string;
  maxSources: number;
  workDir: string;
  schemaPath: string;
  lastMessagePath: string;
}) {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    // The root `web_search` override is the one codex-cli 0.147.0 actually
    // resolves; `tools.web_search=true` resolves to null and forces nothing.
    "--config",
    'web_search="live"',
    "--color",
    "never",
    "--cd",
    options.workDir,
    "--output-schema",
    options.schemaPath,
    "--output-last-message",
    options.lastMessagePath,
    researchPrompt(options.query, options.maxSources),
  ];
}

// Query, answer, and source titles are model/web-controlled strings rendered
// in the TUI: strip ANSI/CSI/OSC sequences and other control characters so
// they cannot inject terminal commands or desync the renderer. Same patterns
// as background-terminals' output sanitizer.
const TERMINAL_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Multi-line safe: keeps newlines and tabs for Markdown answers. */
export function sanitizeText(text: string) {
  return text.replace(TERMINAL_CONTROL_PATTERN, "");
}

/** Single-line variant for fixed-height call/header rendering. */
export function sanitizeLine(text: string) {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}

class MalformedOutputError extends Error {}

function malformed(reason: string) {
  return new MalformedOutputError(
    `Codex returned malformed research output (${reason}). Retry codex_research or fall back to firecrawl_search.`,
  );
}

/** Parses and validates the Codex last message, keeping only deduplicated http(s) sources. */
export function parseResearchOutput(
  raw: string,
  maxSources: number,
): ResearchResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw malformed("not valid JSON");
  }

  const output =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const answer =
    typeof output?.answer === "string"
      ? sanitizeText(output.answer).trim()
      : "";
  if (!output || !answer || !Array.isArray(output.sources)) {
    throw malformed("missing answer or sources");
  }

  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const candidate of output.sources) {
    if (sources.length >= maxSources) break;
    const source =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Record<string, unknown>)
        : undefined;
    if (typeof source?.url !== "string") continue;

    let url: URL;
    try {
      url = new URL(source.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);

    const title =
      typeof source.title === "string" ? sanitizeLine(source.title) : "";
    sources.push({ title: title || url.hostname, url: url.href });
  }

  // A cited answer needs evidence; zero valid sources would let a
  // prior-knowledge answer masquerade as live research.
  if (sources.length === 0) throw malformed("no valid http(s) sources");

  return { answer, sources };
}

export function researchResultText(research: ResearchResult) {
  const sources = research.sources
    .map((source, index) => `${index + 1}. ${source.title} — ${source.url}`)
    .join("\n");
  return `${research.answer}\n\nSources:\n${sources}`;
}

function excerpt(text: string) {
  const lines = sanitizeText(text).trim().split("\n").slice(-5).join("\n");
  return lines.length > 600 ? `…${lines.slice(-599)}` : lines;
}

function processError(result: ExecResult) {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (!detail) {
    return new Error(
      "Codex CLI could not be started. Install the `codex` CLI and make sure it is on PATH; firecrawl_search remains available as a fallback.",
    );
  }
  if (/not logged in|unauthorized|401|log ?in|authenticat/i.test(detail)) {
    return new Error(
      "Codex is not authenticated. Run `codex login` with the ChatGPT account; until then use firecrawl_search as a fallback.",
    );
  }
  if (/usage limit|quota|rate limit|too many requests|429/i.test(detail)) {
    return new Error(
      "Codex usage limit or rate limit reached. Retry later or use firecrawl_search as a fallback.",
    );
  }
  return new Error(
    `Codex research failed (exit ${result.code}): ${excerpt(detail)}`,
  );
}

/** Mirrors the Firecrawl output limits: truncate for context, keep the full text on disk. */
async function boundedOutput(text: string) {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return text;

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-codex-research-"));
  const outputPath = join(outputDirectory, "research.md");
  await writeFile(outputPath, text, "utf8");
  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

/**
 * Runs one ephemeral `codex exec` research session in an empty read-only
 * workspace and returns the validated answer. Never falls back to Firecrawl
 * on its own; errors name the fallback so the model can decide.
 */
export async function runCodexResearch(
  executor: CommandExecutor,
  params: { query: string; maxSources?: number },
  signal?: AbortSignal,
): Promise<AgentToolResult<ResearchDetails>> {
  const query = sanitizeLine(params.query);
  if (!query) {
    throw new Error(
      "codex_research requires a non-empty query. Provide the research question to investigate.",
    );
  }
  const maxSources = Math.min(
    Math.max(Math.trunc(params.maxSources ?? DEFAULT_MAX_SOURCES), 1),
    MAX_SOURCES_LIMIT,
  );
  const startedAt = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-exec-"));

  try {
    const workDir = join(directory, "workspace");
    const schemaPath = join(directory, "schema.json");
    const lastMessagePath = join(directory, "last-message.json");
    await mkdir(workDir);
    await writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), "utf8");

    let result: ExecResult;
    try {
      result = await executor.exec(
        "codex",
        buildCodexArgs({
          query,
          maxSources,
          workDir,
          schemaPath,
          lastMessagePath,
        }),
        { cwd: workDir, signal, timeout: CODEX_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) {
        throw processError({ stdout: "", stderr: "", code: 1, killed: false });
      }
      throw error;
    }

    if (signal?.aborted) throw new Error("Codex research cancelled");
    if (result.killed) {
      throw new Error(
        `Codex research timed out after ${CODEX_TIMEOUT_MS / 1_000} seconds. Narrow the query or use firecrawl_search as a fallback.`,
      );
    }
    if (result.code !== 0) throw processError(result);

    let raw: string;
    try {
      raw = await readFile(lastMessagePath, "utf8");
    } catch {
      throw malformed("no structured output file was written");
    }
    const research = parseResearchOutput(raw, maxSources);

    return {
      content: [
        {
          type: "text",
          text: await boundedOutput(researchResultText(research)),
        },
      ],
      details: {
        provider: "codex",
        durationMs: Math.round(performance.now() - startedAt),
        sourceCount: research.sources.length,
        success: true,
        sources: research.sources,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

function researchDetails(value: unknown): ResearchDetails | undefined {
  const details = value as ResearchDetails | undefined;
  return details?.provider === "codex" && details.success === true
    ? details
    : undefined;
}

function resultText(result: RenderableResult) {
  return result.content.find(
    (item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string",
  )?.text;
}

function summary(details: ResearchDetails) {
  const seconds = Math.round(details.durationMs / 1_000);
  return `✓ ${details.sourceCount} source${details.sourceCount === 1 ? "" : "s"} · ${seconds}s`;
}

export default function codexResearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codex_research",
    label: "Codex Research",
    description: RESEARCH_TOOL_DESCRIPTION,
    promptSnippet: RESEARCH_PROMPT_SNIPPET,
    promptGuidelines: RESEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: RESEARCH_PARAMETER_DESCRIPTIONS.query,
        minLength: 1,
      }),
      maxSources: Type.Optional(
        Type.Integer({
          description: RESEARCH_PARAMETER_DESCRIPTIONS.maxSources,
          minimum: 1,
          maximum: MAX_SOURCES_LIMIT,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Researching with Codex: ${sanitizeLine(params.query)}`,
          },
        ],
        details: undefined,
      });
      return runCodexResearch(pi, params, signal);
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("codex_research"));
      text += ` ${theme.fg("accent", `“${sanitizeLine(args.query)}”`)}`;
      text += theme.fg(
        "muted",
        ` · max ${args.maxSources ?? DEFAULT_MAX_SOURCES} sources`,
      );
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(
          theme.fg(
            "warning",
            sanitizeLine(resultText(result) ?? "") || "Researching…",
          ),
          0,
          0,
        );
      }
      const details = researchDetails(result.details);
      if (context.isError || !details) {
        return new Text(
          theme.fg(
            "error",
            sanitizeText(resultText(result) ?? "").trim() ||
              "Codex research failed",
          ),
          0,
          0,
        );
      }

      if (!expanded) {
        let text = theme.fg("success", summary(details));
        for (const [index, source] of details.sources.slice(0, 3).entries()) {
          text += `\n${theme.fg("accent", `${index + 1}. ${sanitizeLine(source.title)}`)}`;
          text += theme.fg("dim", ` — ${source.url}`);
        }
        if (details.sources.length > 3) {
          text += `\n${theme.fg("dim", `… ${details.sources.length - 3} more`)}`;
        }
        text += `\n${expandHint(theme)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("success", summary(details)), 0, 0));
      container.addChild(
        new Markdown(resultText(result) ?? "", 0, 0, getMarkdownTheme()),
      );
      return container;
    },
  });
}

function expandHint(theme: Theme) {
  return theme.fg("dim", keyHint("app.tools.expand", "to expand"));
}
