import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FIRECRAWL_BUDGET,
  FIRECRAWL_USAGE_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";
import { withHerdrBlocked } from "../shared/herdr.ts";

const BUDGET_ENTRY = "developer-search-budget";
type Usage = { units: number; auth?: "anonymous" | "account" };
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function estimatedCreditsForCall(toolName: string, input: unknown) {
  if (toolName !== "developer-search") return 0;
  const limit = record(input)?.limit;
  const count =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(1, Math.min(20, Math.floor(limit)))
      : 10;
  return Math.ceil(count / 10) * 2;
}

export function usageForEntries(entries: readonly SessionEntry[]) {
  let unitsUsed = 0;
  let anonymousUnits = 0;
  let accountCredits = 0;
  const toolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult")
      continue;
    const message = entry.message;
    if (
      message.toolName !== "developer-search" ||
      toolCallIds.has(message.toolCallId)
    )
      continue;
    const usage = record(record(message.details)?.developerUsage);
    // Old sessions lack authentication attribution. Do not invent billed usage.
    if (
      !usage ||
      typeof usage.units !== "number" ||
      !Number.isFinite(usage.units) ||
      usage.units < 0 ||
      !["anonymous", "account"].includes(String(usage.auth))
    )
      continue;
    toolCallIds.add(message.toolCallId);
    unitsUsed += usage.units;
    if (usage.auth === "anonymous") anonymousUnits += usage.units;
    else accountCredits += usage.units;
  }
  return { unitsUsed, anonymousUnits, accountCredits, toolCallIds };
}

/** Attempt-based estimates, not billing receipts. Hosted MCP is not metered here. */
export function registerUsageTracking(pi: ExtensionAPI) {
  let state = usageForEntries([]);
  let budget = DEFAULT_FIRECRAWL_BUDGET;
  let unlimited = false;
  const reservations = new Map<string, Usage>();
  const publish = () =>
    pi.events.emit(FIRECRAWL_USAGE_CHANNEL, {
      unitsUsed: state.unitsUsed,
      anonymousUnits: state.anonymousUnits,
      accountCredits: state.accountCredits,
      budget,
      unlimited,
    });
  const restore = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    state = usageForEntries(entries);
    budget = DEFAULT_FIRECRAWL_BUDGET;
    unlimited = false;
    reservations.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== BUDGET_ENTRY)
        continue;
      const data = record(entry.data);
      if (typeof data?.budget === "number" && Number.isFinite(data.budget))
        budget = Math.max(budget, data.budget);
      if (data?.unlimited === true) unlimited = true;
    }
    publish();
  };
  const stopRefresh = pi.events.on(REFRESH_CHANNEL, publish);
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "developer-search") return;
    const units = estimatedCreditsForCall(event.toolName, event.input);
    const reserved = [...reservations.values()].reduce(
      (sum, usage) => sum + usage.units,
      0,
    );
    const projected = state.unitsUsed + reserved + units;
    if (!unlimited && projected > budget) {
      const proposed = Math.ceil(projected / 5) * 5;
      const reason = `Developer Search request would use ${projected} estimated units, above the ${budget}-unit session budget. Anonymous units are not account credits.`;
      if (!ctx.hasUI)
        return {
          block: true,
          reason: `${reason} Approve a higher budget in an interactive session.`,
        };
      const raise = `Raise budget to ${proposed} units`;
      const allow = "Allow Developer Search for this session";
      const choice = await withHerdrBlocked(
        pi,
        "Waiting for Developer Search budget approval",
        () => ctx.ui.select(reason, [raise, allow, "Decline"]),
      );
      if (choice === allow) {
        unlimited = true;
        pi.appendEntry(BUDGET_ENTRY, { unlimited: true });
      } else if (choice === raise) {
        budget = proposed;
        pi.appendEntry(BUDGET_ENTRY, { budget });
      } else
        return { block: true, reason: "Developer Search request declined." };
    }
    reservations.set(event.toolCallId, { units });
    publish();
  });
  pi.on("tool_result", (event) => {
    const usage = reservations.get(event.toolCallId);
    reservations.delete(event.toolCallId);
    if (!usage?.auth || state.toolCallIds.has(event.toolCallId)) return;
    state.toolCallIds.add(event.toolCallId);
    state.unitsUsed += usage.units;
    if (usage.auth === "anonymous") state.anonymousUnits += usage.units;
    else state.accountCredits += usage.units;
    publish();
    return { details: { ...record(event.details), developerUsage: usage } };
  });
  pi.on("session_shutdown", () => {
    stopRefresh();
    reservations.clear();
  });
  return (toolCallId: string, auth: "anonymous" | "account") => {
    const reservation = reservations.get(toolCallId);
    if (reservation) reservation.auth = auth;
  };
}
