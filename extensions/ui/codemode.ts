import type { CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import type { ToolResult, ToolRowSpec } from "./tool-rows.ts";

type NestedCall = CodemodeToolDetails["calls"][number];

function nestedCalls(details: unknown): readonly Partial<NestedCall>[] {
  if (typeof details !== "object" || details === null) return [];
  if (!("calls" in details) || !Array.isArray(details.calls)) return [];
  return details.calls;
}

/** Matches Pi's codemode cost format: cents, or two significant digits below a cent. */
function formatCost(cost: number) {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** The script is not useful in one line; show the nested call count and model cost instead. */
export const codemodeRow: ToolRowSpec = {
  label: () => "codemode",
  summarize(result: ToolResult, theme) {
    const calls = nestedCalls(result.details);
    const failed = calls.filter((call) => call.status === "error").length;
    const cost = calls.reduce(
      (total, call) => total + (typeof call.cost === "number" ? call.cost : 0),
      0,
    );
    let detail = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
    if (failed > 0) detail += `, ${failed} failed`;
    return {
      detail: theme.fg("muted", detail),
      trailer: cost > 0 ? theme.fg("dim", formatCost(cost)) : undefined,
    };
  },
};
