import type {
  CodemodeToolDetails,
  Theme,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

type NestedCall = CodemodeToolDetails["calls"][number];
type RenderResultArgs = Parameters<NonNullable<ToolRenderers["renderResult"]>>;

interface Summary {
  readonly calls: number;
  readonly failedCalls: number;
  readonly cost: number;
  readonly status: "running" | "ok" | "error";
  readonly durationMs: number | undefined;
}

/**
 * Pi renders a row's call before its result, but draws both afterwards, so the
 * call line reads the summary the result stored in the row's shared state.
 */
interface RowState {
  codemodeSummary?: Summary;
}

/** Components drawn here; Pi's renderer must not receive them for reuse. */
const compactComponents = new WeakSet<Component>();

function compact<T extends Component>(component: T) {
  compactComponents.add(component);
  return component;
}

function forBuiltIn<T extends { lastComponent: Component | undefined }>(
  context: T,
): T {
  return context.lastComponent && compactComponents.has(context.lastComponent)
    ? { ...context, lastComponent: undefined }
    : context;
}

function nestedCalls(details: unknown): readonly Partial<NestedCall>[] {
  if (typeof details !== "object" || details === null) return [];
  if (!("calls" in details) || !Array.isArray(details.calls)) return [];
  return details.calls;
}

function summarize([result, options, , context]: RenderResultArgs): Summary {
  const calls = nestedCalls(result.details);
  return {
    calls: calls.length,
    failedCalls: calls.filter((call) => call.status === "error").length,
    cost: calls.reduce(
      (total, call) => total + (typeof call.cost === "number" ? call.cost : 0),
      0,
    ),
    status: options.isPartial ? "running" : context.isError ? "error" : "ok",
    durationMs: context.durationMs,
  };
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Matches Pi's codemode cost format: cents, or two significant digits below a cent. */
function formatCost(cost: number) {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function formatSummary(theme: Theme, summary: Summary | undefined) {
  const title = theme.fg("toolTitle", theme.bold("codemode"));
  const separator = theme.fg("dim", " · ");
  if (!summary) return `${title}${separator}${theme.fg("warning", "…")}`;

  let calls = `${summary.calls} ${summary.calls === 1 ? "call" : "calls"}`;
  if (summary.failedCalls > 0) calls += `, ${summary.failedCalls} failed`;
  const status = {
    running: theme.fg("warning", "…"),
    ok: theme.fg("success", "✓"),
    error: theme.fg("error", "✗"),
  }[summary.status];
  const parts = [title, theme.fg("muted", calls), status];
  if (summary.durationMs !== undefined) {
    parts.push(theme.fg("dim", formatDuration(summary.durationMs)));
  }
  if (summary.cost > 0) parts.push(theme.fg("dim", formatCost(summary.cost)));
  return parts.join(separator);
}

/** Collapse codemode rows to one line; Ctrl+O shows Pi's full script, calls and output. */
export const compactCodemodeRenderer: ToolRendererResolver = (
  toolName,
  next,
) => {
  const builtIn = next();
  if (
    toolName !== "codemode" ||
    !builtIn?.renderCall ||
    !builtIn.renderResult
  ) {
    return builtIn;
  }
  const { renderCall, renderResult } = builtIn;

  return {
    ...builtIn,
    renderCall(args, theme, context) {
      if (context.expanded) return renderCall(args, theme, forBuiltIn(context));
      const state: RowState = context.state;
      return compact({
        render: (width: number) => [
          truncateToWidth(formatSummary(theme, state.codemodeSummary), width),
        ],
        invalidate() {},
      });
    },
    renderResult(result, options, theme, context) {
      if (options.expanded) {
        return renderResult(result, options, theme, forBuiltIn(context));
      }
      const state: RowState = context.state;
      state.codemodeSummary = summarize([result, options, theme, context]);
      return compact(new Container());
    },
  };
};
