/**
 * file-search — first-class `fd`, `rg`, and `fuzzy-find` tools for pi.
 *
 * On session start the extension resolves the required system binaries.
 * Tools await that initialization before executing and report a clear error
 * when `fd`/`fdfind`, `rg`, or `fzf` is unavailable.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Data, Effect, Exit } from "effect";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  buildFdArgs,
  buildFuzzyFdArgs,
  buildFzfArgs,
  buildRgArgs,
  FD_MAX_DEPTH_LIMIT,
  FD_MAX_LIMIT,
  FUZZY_MAX_LIMIT,
  resolveFuzzyLimit,
  RG_MAX_CONTEXT,
  RG_MAX_COUNT_LIMIT,
  type FuzzyFindParams,
} from "./src/args.ts";
import {
  liveBinaryEnv,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
  type BinarySource,
} from "./src/binaries.ts";
import {
  formatCapturedOutput,
  formatOutput,
  type CapturedOutput,
} from "./src/output.ts";
import {
  FD_PARAMETER_DESCRIPTIONS,
  FD_PROMPT_GUIDELINES,
  FD_PROMPT_SNIPPET,
  FD_TOOL_DESCRIPTION,
  FUZZY_PARAMETER_DESCRIPTIONS,
  FUZZY_PROMPT_GUIDELINES,
  FUZZY_PROMPT_SNIPPET,
  FUZZY_TOOL_DESCRIPTION,
  RG_PARAMETER_DESCRIPTIONS,
  RG_PROMPT_GUIDELINES,
  RG_PROMPT_SNIPPET,
  RG_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";
import { executeFuzzyPipeline } from "./src/fuzzy.ts";

export function makeBinaryInitializers(env: BinaryEnv) {
  return {
    fd: Effect.runSync(Effect.cached(resolveBinary(TOOL_SPECS.fd, env))),
    rg: Effect.runSync(Effect.cached(resolveBinary(TOOL_SPECS.rg, env))),
    fzf: Effect.runSync(Effect.cached(resolveBinary(TOOL_SPECS.fzf, env))),
  };
}

class SearchError extends Data.TaggedError("SearchError")<{
  readonly message: string;
}> {}

interface SearchOutcome {
  readonly output: CapturedOutput;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

export interface FdToolDetails {
  readonly binarySource: BinarySource;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface RgToolDetails {
  readonly binarySource: BinarySource;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface FuzzyFindToolDetails {
  readonly binarySource: BinarySource;
  /** Paths returned to the model (bounded by limit). */
  readonly matchCount: number;
  /** All fuzzy matches fzf reported, including those beyond limit. */
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

/** Apply the shared timeout, error normalization, and platform services. */
function withToolLifecycle<A, E extends { readonly _tag: string }, R>(
  tool: string,
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(
    Effect.timeout(EXEC_TIMEOUT_MS),
    Effect.mapError((error) => {
      if (error instanceof SearchError) return error;
      return new SearchError({
        message:
          error._tag === "TimeoutError"
            ? `${tool} timed out.`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }),
    Effect.provide(NodeServices.layer),
  );
}

function causeMessage<E>(cause: Cause.Cause<E>) {
  const [first] = Cause.prettyErrors(cause);
  return first?.message ?? Cause.pretty(cause);
}

function unwrapToolExit<A, E>(exit: Exit.Exit<A, E>, tool: string) {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(`${tool} search was cancelled.`);
  }
  throw new Error(causeMessage(exit.cause));
}

export default function fileSearchTools(pi: ExtensionAPI) {
  let notified = false;

  const initializers = makeBinaryInitializers(liveBinaryEnv);

  pi.on("session_start", async (_event, ctx) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const initialized = yield* Effect.all(
          {
            fd: Effect.exit(initializers.fd),
            rg: Effect.exit(initializers.rg),
            fzf: Effect.exit(initializers.fzf),
          },
          { concurrency: "unbounded" },
        );
        if (!ctx.hasUI || notified) return;

        notified = true;
        for (const tool of ["fd", "rg", "fzf"] as const) {
          const toolExit = initialized[tool];
          if (Exit.isFailure(toolExit)) {
            ctx.ui.notify(
              `file-search ${tool} setup failed: ${causeMessage(toolExit.cause)}`,
              "error",
            );
          }
        }
      }),
    );

    if (Exit.isFailure(exit) && ctx.hasUI && !notified) {
      notified = true;
      ctx.ui.notify(
        `file-search setup failed: ${causeMessage(exit.cause)}`,
        "error",
      );
    }
  });

  /** Await init, stream the binary output to disk, and classify its exit. */
  function runSearch(tool: "fd" | "rg", args: string[], ctx: ExtensionContext) {
    return Effect.gen(function* () {
      const binary = yield* initializers[tool];
      const result = yield* executeSearchProcess({
        command: binary.command,
        args,
        cwd: ctx.cwd,
        tempPrefix: `pi-${tool}-`,
      });

      // ripgrep exits 1 for "no matches"; fd exits 0 even with no results.
      if (tool === "rg" && result.code === 1 && result.output.lineCount === 0) {
        return {
          output: result.output,
          noMatches: true,
          binarySource: binary.source,
        } satisfies SearchOutcome;
      }
      if (result.code !== 0) {
        yield* discardCapturedOutput(result.output);
        const detail = result.stderr.trim() || `exit code ${result.code}`;
        return yield* new SearchError({ message: `${tool} failed: ${detail}` });
      }
      return {
        output: result.output,
        noMatches: result.output.lineCount === 0,
        binarySource: binary.source,
      } satisfies SearchOutcome;
    }).pipe((effect) => withToolLifecycle(tool, effect));
  }

  /** Await init, run the fd → fzf pipeline, and classify both exits. */
  function runFuzzyFind(params: FuzzyFindParams, ctx: ExtensionContext) {
    return Effect.gen(function* () {
      const fd = yield* initializers.fd;
      const fzf = yield* initializers.fzf;
      const result = yield* executeFuzzyPipeline({
        source: { command: fd.command, args: buildFuzzyFdArgs(params) },
        filter: { command: fzf.command, args: buildFzfArgs(params) },
        cwd: ctx.cwd,
        limit: resolveFuzzyLimit(params.limit),
      });

      if (result.sourceCode !== 0) {
        const detail =
          result.sourceStderr.trim() || `exit code ${result.sourceCode}`;
        return yield* new SearchError({ message: `fd failed: ${detail}` });
      }
      // fzf exits 1 when the filter matches nothing; that is a normal result.
      if (result.filterCode !== 0 && result.filterCode !== 1) {
        const detail =
          result.filterStderr.trim() || `exit code ${result.filterCode}`;
        return yield* new SearchError({ message: `fzf failed: ${detail}` });
      }
      return {
        paths: result.paths,
        totalMatches: result.matchCount,
        binarySource: fzf.source,
      };
    }).pipe((effect) => withToolLifecycle("fuzzy-find", effect));
  }

  pi.registerTool<ReturnType<typeof fdParameters>, FdToolDetails>({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const outcome = yield* runSearch("fd", buildFdArgs(params), ctx);
          if (outcome.noMatches) {
            return {
              content: [{ type: "text", text: "No files found" }],
              details: {
                binarySource: outcome.binarySource,
                matchCount: 0,
                truncated: false,
              },
            } satisfies AgentToolResult<FdToolDetails>;
          }

          const formatted = formatCapturedOutput(outcome.output);
          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              binarySource: outcome.binarySource,
              matchCount: formatted.lineCount,
              truncated: formatted.truncated,
              fullOutputPath: formatted.fullOutputPath,
            },
          } satisfies AgentToolResult<FdToolDetails>;
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "fd");
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", args.pattern ? `"${args.pattern}"` : "(all)");
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.type && `type=${args.type}`,
        args.extension && `ext=${args.extension}`,
        args.glob && "glob",
        args.hidden && "hidden",
        args.maxDepth !== undefined && `depth≤${args.maxDepth}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.matchCount === 0) {
        return new Text(theme.fg("dim", "No files found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof rgParameters>, RgToolDetails>({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const outcome = yield* runSearch("rg", buildRgArgs(params), ctx);
          if (outcome.noMatches) {
            return {
              content: [{ type: "text", text: "No matches found" }],
              details: {
                binarySource: outcome.binarySource,
                outputLines: 0,
                truncated: false,
              },
            } satisfies AgentToolResult<RgToolDetails>;
          }

          const formatted = formatCapturedOutput(outcome.output);
          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              binarySource: outcome.binarySource,
              outputLines: formatted.lineCount,
              truncated: formatted.truncated,
              fullOutputPath: formatted.fullOutputPath,
            },
          } satisfies AgentToolResult<RgToolDetails>;
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "rg");
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${args.pattern}"`);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.glob && `glob=${args.glob}`,
        args.fileType && `type=${args.fileType}`,
        args.fixedStrings && "literal",
        args.hidden && "hidden",
        args.context !== undefined && `ctx=${args.context}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.outputLines === 0) {
        return new Text(theme.fg("dim", "No matches found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof fuzzyFindParameters>, FuzzyFindToolDetails>(
    {
      name: "fuzzy-find",
      label: "Fuzzy Find Paths",
      description: FUZZY_TOOL_DESCRIPTION,
      promptSnippet: FUZZY_PROMPT_SNIPPET,
      promptGuidelines: FUZZY_PROMPT_GUIDELINES,
      parameters: fuzzyFindParameters(),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const exit = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const outcome = yield* runFuzzyFind(params, ctx);
            if (outcome.totalMatches === 0) {
              return {
                content: [{ type: "text", text: "No matches found" }],
                details: {
                  binarySource: outcome.binarySource,
                  matchCount: 0,
                  totalMatches: 0,
                  truncated: false,
                },
              } satisfies AgentToolResult<FuzzyFindToolDetails>;
            }

            const formatted = yield* Effect.promise(() =>
              formatOutput(outcome.paths.join("\n"), {
                tempPrefix: "pi-fuzzy-find-",
              }),
            );
            const hiddenMatches = outcome.totalMatches - outcome.paths.length;
            const text =
              hiddenMatches > 0
                ? `${formatted.text}\n\n[${hiddenMatches} additional fuzzy ${
                    hiddenMatches === 1 ? "match" : "matches"
                  } not shown; refine the query or raise limit]`
                : formatted.text;
            return {
              content: [{ type: "text", text }],
              details: {
                binarySource: outcome.binarySource,
                matchCount: outcome.paths.length,
                totalMatches: outcome.totalMatches,
                truncated: formatted.truncated || hiddenMatches > 0,
                fullOutputPath: formatted.fullOutputPath,
              },
            } satisfies AgentToolResult<FuzzyFindToolDetails>;
          }),
          signal ? { signal } : undefined,
        );
        return unwrapToolExit(exit, "fuzzy-find");
      },

      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("fuzzy-find "));
        text += theme.fg("accent", `"${args.query}"`);
        if (args.path) text += theme.fg("muted", ` in ${args.path}`);
        const flags = [
          args.type && `type=${args.type}`,
          args.hidden && "hidden",
          args.limit !== undefined && `limit=${args.limit}`,
        ].filter((flag): flag is string => typeof flag === "string");
        if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
        return new Text(text, 0, 0);
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial)
          return new Text(theme.fg("warning", "Searching..."), 0, 0);
        const details = result.details;
        if (!details || details.totalMatches === 0) {
          return new Text(theme.fg("dim", "No matches found"), 0, 0);
        }
        let text = theme.fg(
          "success",
          `${details.matchCount} ${details.matchCount === 1 ? "match" : "matches"}`,
        );
        if (details.totalMatches > details.matchCount) {
          text += theme.fg("warning", ` (of ${details.totalMatches})`);
        }
        if (expanded)
          text += expandedPreview(result, details.fullOutputPath, theme);
        return new Text(text, 0, 0);
      },
    },
  );
}

const PREVIEW_LINES = 20;

interface ThemeLike {
  fg(color: string, text: string): string;
}

function expandedPreview(
  result: { content: { type: string; text?: string }[] },
  fullOutputPath: string | undefined,
  theme: ThemeLike,
) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = content.text.split("\n");
    for (const line of lines.slice(0, PREVIEW_LINES)) {
      text += `\n${theme.fg("dim", line)}`;
    }
    if (lines.length > PREVIEW_LINES) {
      text += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
    }
  }
  if (fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`;
  }
  return text;
}

export function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.pattern }),
    ),
    path: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: FD_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    extension: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.extension }),
    ),
    glob: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.glob }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    maxDepth: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.maxDepth,
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

export function fuzzyFindParameters() {
  return Type.Object({
    query: Type.String({
      description: FUZZY_PARAMETER_DESCRIPTIONS.query,
      minLength: 1,
    }),
    path: Type.Optional(
      Type.String({ description: FUZZY_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory"] as const, {
        description: FUZZY_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FUZZY_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FUZZY_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FUZZY_MAX_LIMIT,
      }),
    ),
  });
}

export function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: RG_PARAMETER_DESCRIPTIONS.pattern }),
    path: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.path }),
    ),
    glob: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.glob }),
    ),
    fileType: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.fileType }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.caseSensitive }),
    ),
    fixedStrings: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.fixedStrings }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}
