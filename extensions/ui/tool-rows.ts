import type {
  Theme,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Spacer,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
export type ToolResult = Parameters<RenderResult>[0];

/** Tool-specific additions to a collapsed row. */
export interface RowSummary {
  /** Shown between the label and the status, for example "5 calls". */
  readonly detail?: string;
  /** Shown after the status and duration, for example a cost or an error. */
  readonly trailer?: string;
}

export interface ToolRowSpec {
  /** Replaces the first line of the tool's own call rendering. */
  readonly label?: (theme: Theme) => string;
  readonly summarize?: (result: ToolResult, theme: Theme) => RowSummary;
}

interface RowState {
  innerCall?: Component;
  innerResult?: Component;
  summary?: RowSummary;
}

/**
 * Pi keeps one state object per tool row and passes it to both renderers. Keying
 * by it keeps this module's state out of the tool's own renderer state.
 */
const rows = new WeakMap<object, RowState>();

function rowState(context: RenderContext): RowState {
  const key: object = context.state;
  let state = rows.get(key);
  if (!state) {
    state = {};
    rows.set(key, state);
  }
  return state;
}

const SEPARATOR = " · ";

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Errors end with their summary, such as bash's "Command exited with code 1". */
function lastTextLine(result: ToolResult): string | undefined {
  return result.content
    .flatMap((block) => (block.type === "text" ? block.text.split("\n") : []))
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Fullscreen mode's "auto" scrollbar is drawn over the last column while
 * scrolling. Truncated rows leave it free so their status stays visible.
 */
const SCROLLBAR_GUTTER = 1;

/** Wide enough that a call line is not wrapped before the row truncates it. */
const UNWRAPPED_WIDTH = 1000;

/** First non-blank line, without trailing padding but with its styling. */
function firstVisibleLine(component: Component) {
  for (const line of component.render(UNWRAPPED_WIDTH)) {
    const width = visibleWidth(stripTerminalSequences(line).trimEnd());
    if (width > 0) return truncateToWidth(line, width, "");
  }
  return undefined;
}

function statusParts(theme: Theme, context: RenderContext): string[] {
  if (context.isPartial) return [theme.fg("warning", "…")];
  const status = context.isError
    ? theme.fg("error", "✗")
    : theme.fg("success", "✓");
  return context.durationMs === undefined
    ? [status]
    : [status, theme.fg("dim", formatDuration(context.durationMs))];
}

/** Pi's default shell: a padded block whose background shows the row's status. */
function frame(
  content: Component,
  theme: Theme,
  context: RenderContext,
  position: "call" | "result",
) {
  const bg = context.isPartial
    ? "toolPendingBg"
    : context.isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  const box = new Box(context.outputPad, 0, (text) => theme.bg(bg, text));
  if (position === "call") box.addChild(new Spacer(1));
  box.addChild(content);
  if (position === "result") box.addChild(new Spacer(1));
  return box;
}

/** Pi's fallback for tools without a call renderer: the name and its arguments. */
function fallbackCall(
  toolName: string,
  args: unknown,
  theme: Theme,
  expanded: boolean,
) {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const entries =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? Object.entries(args)
      : args === undefined
        ? []
        : [["args", args] as const];
  const json = (value: unknown, indent?: number) =>
    JSON.stringify(value, null, indent) ?? String(value);
  const text = expanded
    ? entries.map(
        ([key, value]) =>
          `\n  ${key}: ${typeof value === "string" ? value : json(value, 2)}`,
      )
    : entries.map(([key, value]) => ` ${key}=${json(value)}`);
  return new Text(title + theme.fg("muted", text.join("")), 0, 0);
}

function fallbackResult(result: ToolResult, theme: Theme) {
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return new Text(theme.fg("toolOutput", text), 0, 0);
}

/**
 * Collapse every tool row to one line: the tool's own call summary, status,
 * duration and, on failure, the first error line. Ctrl+O or a click on the row
 * shows the tool's full rendering.
 */
export function compactToolRows(
  specs: Readonly<Record<string, ToolRowSpec>> = {},
): ToolRendererResolver {
  return (toolName, next) => {
    const builtIn = next();
    const spec = specs[toolName];
    const ownFraming = builtIn?.renderShell === "self";

    const innerCall: RenderCall = (args, theme, context) => {
      const state = rowState(context);
      const component = builtIn?.renderCall
        ? builtIn.renderCall(args, theme, {
            ...context,
            lastComponent: state.innerCall,
          })
        : fallbackCall(toolName, args, theme, context.expanded);
      state.innerCall = component;
      return component;
    };

    return {
      ...builtIn,
      renderShell: "self",
      renderCall(args, theme, context) {
        if (context.expanded) {
          const call = innerCall(args, theme, context);
          return ownFraming ? call : frame(call, theme, context, "call");
        }

        const call = spec?.label ? undefined : innerCall(args, theme, context);
        const state = rowState(context);
        const status = statusParts(theme, context);
        return {
          render(width: number) {
            const pad = " ".repeat(context.outputPad);
            const available = Math.max(
              1,
              width - context.outputPad - SCROLLBAR_GUTTER,
            );
            const { detail, trailer } = state.summary ?? {};
            const suffix = [
              ...(detail ? [detail] : []),
              ...status,
              ...(trailer ? [trailer] : []),
            ].join(theme.fg("dim", SEPARATOR));
            const labelWidth = Math.max(
              Math.min(12, available),
              available - visibleWidth(SEPARATOR) - visibleWidth(suffix),
            );
            const label =
              spec?.label?.(theme) ??
              (call && firstVisibleLine(call)) ??
              theme.fg("toolTitle", theme.bold(toolName));
            const line =
              truncateToWidth(label, labelWidth, theme.fg("dim", "…")) +
              theme.fg("dim", SEPARATOR) +
              suffix;
            return [pad + truncateToWidth(line, available, "")];
          },
          invalidate() {
            call?.invalidate();
          },
        };
      },
      renderResult(result, options, theme, context) {
        const state = rowState(context);
        if (options.expanded) {
          const component = builtIn?.renderResult
            ? builtIn.renderResult(result, options, theme, {
                ...context,
                lastComponent: state.innerResult,
              })
            : fallbackResult(result, theme);
          state.innerResult = component;
          return ownFraming
            ? component
            : frame(component, theme, context, "result");
        }

        const summary = spec?.summarize?.(result, theme) ?? {};
        const error =
          context.isError && !options.isPartial
            ? lastTextLine(result)
            : undefined;
        state.summary = error
          ? {
              ...summary,
              trailer: [summary.trailer, theme.fg("error", error)]
                .filter(Boolean)
                .join(theme.fg("dim", SEPARATOR)),
            }
          : summary;
        // The call line draws the whole row.
        return { render: () => [], invalidate() {} };
      },
    };
  };
}
