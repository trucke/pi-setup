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

const FIRECRAWL_BUDGET_ENTRY = "firecrawl-budget";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_CRAWL_LIMIT = 5;
const ALLOW_SESSION_OPTION = "Allow all Firecrawl requests for this session";
const DECLINE_OPTION = "Decline this request";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Maps a tool call to the Firecrawl operation it spends credits on, or
 * undefined for calls that never touch Firecrawl. web-search and web-fetch
 * default to Exa and only spend (and reserve) credits when the model
 * explicitly requests backend "firecrawl"; web-crawl is always Firecrawl.
 * Legacy persisted names remain recognized for session restoration.
 */
export function firecrawlOperation(toolName: string, input: unknown) {
  switch (toolName) {
    case "firecrawl_search":
      return "search";
    case "firecrawl_scrape":
      return "scrape";
    case "web-crawl":
    case "firecrawl_crawl":
      return "crawl";
    case "web-search":
      return record(input)?.backend === "firecrawl" ? "search" : undefined;
    case "web-fetch":
      return record(input)?.backend === "firecrawl" ? "scrape" : undefined;
    default:
      return undefined;
  }
}

function creditValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function limitValue(input: unknown, fallback: number) {
  const limit = creditValue(record(input)?.limit);
  return limit === undefined ? fallback : Math.max(1, Math.floor(limit));
}

export function estimatedCreditsForCall(toolName: string, input: unknown) {
  const operation = firecrawlOperation(toolName, input);
  if (operation === "search") {
    const limit = limitValue(input, DEFAULT_SEARCH_LIMIT);
    const searchCredits = Math.ceil(limit / 10) * 2;
    return record(input)?.scrapeResults === true
      ? searchCredits + limit
      : searchCredits;
  }
  if (operation === "scrape") return 1;
  if (operation === "crawl") {
    return limitValue(input, DEFAULT_CRAWL_LIMIT);
  }
  return 0;
}

function searchResultGroups(details: unknown) {
  const result = record(details);
  if (!result) return [];

  return ["web", "news", "images"].map((source) => {
    const items = result[source];
    return Array.isArray(items) ? items : [];
  });
}

function searchCredits(details: unknown, input: unknown) {
  const result = record(details);
  const reported = creditValue(result?.creditsUsed);
  if (reported !== undefined) return reported;

  const groups = searchResultGroups(details);
  const baseCredits = Math.max(
    Math.ceil(limitValue(input, DEFAULT_SEARCH_LIMIT) / 10) * 2,
    groups.reduce(
      (total, items) =>
        total + (items.length === 0 ? 0 : Math.ceil(items.length / 10) * 2),
      0,
    ),
  );
  const scrapeCredits = groups.flat().reduce((total, item) => {
    const resultItem = record(item);
    const metadata = record(resultItem?.metadata);
    const reportedCredits = creditValue(metadata?.creditsUsed);
    const inferredCredits =
      typeof resultItem?.markdown === "string" && reportedCredits === undefined
        ? 1
        : 0;
    return total + (reportedCredits ?? inferredCredits);
  }, 0);
  return baseCredits + scrapeCredits;
}

export function creditsForFirecrawlResult(
  toolName: string,
  details: unknown,
  input: unknown = {},
  isError = false,
) {
  const operation = firecrawlOperation(toolName, input);
  if (!operation) return 0;

  const result = record(details);
  if (result?.localCacheHit === true || result?.localBudgetBlocked === true) {
    return 0;
  }
  if (isError) return estimatedCreditsForCall(toolName, input);

  if (operation === "search") {
    return searchCredits(details, input);
  }
  if (operation === "crawl") {
    return (
      creditValue(result?.creditsUsed) ??
      estimatedCreditsForCall(toolName, input)
    );
  }

  const metadata = record(result?.metadata);
  return (
    creditValue(metadata?.creditsUsed) ??
    estimatedCreditsForCall(toolName, input)
  );
}

function toolCallInputs(entries: readonly SessionEntry[]) {
  const inputs = new Map<string, unknown>();

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    for (const part of entry.message.content) {
      const call = record(part);
      if (
        call?.type === "toolCall" &&
        typeof call.id === "string" &&
        typeof call.name === "string" &&
        firecrawlOperation(call.name, call.arguments) !== undefined
      ) {
        inputs.set(call.id, call.arguments);
      }
    }
  }

  return inputs;
}

export function usageForEntries(entries: readonly SessionEntry[]) {
  const inputs = toolCallInputs(entries);
  const toolCallIds = new Set<string>();
  let creditsUsed = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (
      message.role !== "toolResult" ||
      toolCallIds.has(message.toolCallId) ||
      firecrawlOperation(message.toolName, inputs.get(message.toolCallId)) ===
        undefined
    ) {
      continue;
    }

    toolCallIds.add(message.toolCallId);
    creditsUsed += creditsForFirecrawlResult(
      message.toolName,
      message.details,
      inputs.get(message.toolCallId),
      message.isError,
    );
  }

  return { creditsUsed, toolCallIds };
}

function budgetSettingsForEntries(entries: readonly SessionEntry[]) {
  let budget = DEFAULT_FIRECRAWL_BUDGET;
  let unlimited = false;

  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== FIRECRAWL_BUDGET_ENTRY
    ) {
      continue;
    }

    const data = record(entry.data);
    const saved = creditValue(data?.budget);
    if (saved !== undefined) budget = Math.max(budget, saved);
    if (data?.unlimited === true) unlimited = true;
  }

  return { budget, unlimited };
}

/**
 * Tracks Firecrawl session credits: reserves in-flight calls against the
 * budget, asks for approval on overruns, and publishes usage for the
 * dashboard. Exa-backed calls are free and never gated here.
 */
export function registerUsageTracking(pi: ExtensionAPI) {
  let creditsUsed = 0;
  let budget = DEFAULT_FIRECRAWL_BUDGET;
  let unlimited = false;
  let toolCallIds = new Set<string>();
  const reservations = new Map<string, number>();
  const blockedToolCallIds = new Set<string>();

  const publish = () =>
    pi.events.emit(FIRECRAWL_USAGE_CHANNEL, {
      creditsUsed,
      budget,
      unlimited,
    });

  const restore = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    const restored = usageForEntries(entries);
    const budgetSettings = budgetSettingsForEntries(entries);
    creditsUsed = restored.creditsUsed;
    budget = budgetSettings.budget;
    unlimited = budgetSettings.unlimited;
    toolCallIds = restored.toolCallIds;
    reservations.clear();
    blockedToolCallIds.clear();
    publish();
  };

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, publish);

  pi.on("session_start", (_event, ctx) => restore(ctx));

  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("tool_call", async (event, ctx) => {
    if (firecrawlOperation(event.toolName, event.input) === undefined) return;

    const estimate = estimatedCreditsForCall(event.toolName, event.input);
    const reserved = [...reservations.values()].reduce(
      (total, credits) => total + credits,
      0,
    );
    const projected = creditsUsed + reserved + estimate;

    if (!unlimited && projected > budget) {
      const proposedBudget = Math.ceil(projected / 5) * 5;
      if (!ctx.hasUI) {
        blockedToolCallIds.add(event.toolCallId);
        return {
          block: true,
          reason: `Firecrawl request blocked: projected usage is ${projected} credits, above the ${budget}-credit session budget. Reduce the scope or approve a higher budget in an interactive session.`,
        };
      }

      const raiseBudgetOption = `Approve and raise the session budget to ${proposedBudget} credits`;
      const approval = await withHerdrBlocked(
        pi,
        "Waiting for Firecrawl budget approval",
        () =>
          ctx.ui.select(
            `${event.toolName} would bring projected usage to ${projected} credits (current budget: ${budget})`,
            [raiseBudgetOption, ALLOW_SESSION_OPTION, DECLINE_OPTION],
          ),
      );
      if (approval === ALLOW_SESSION_OPTION) {
        unlimited = true;
        pi.appendEntry(FIRECRAWL_BUDGET_ENTRY, { unlimited: true });
        publish();
      } else if (approval === raiseBudgetOption) {
        budget = proposedBudget;
        pi.appendEntry(FIRECRAWL_BUDGET_ENTRY, { budget });
        publish();
      } else {
        blockedToolCallIds.add(event.toolCallId);
        return {
          block: true,
          reason: `Firecrawl request declined because projected usage exceeds the ${budget}-credit session budget.`,
        };
      }
    }

    reservations.set(event.toolCallId, estimate);
  });

  pi.on("tool_result", (event) => {
    reservations.delete(event.toolCallId);
    if (firecrawlOperation(event.toolName, event.input) === undefined) return;

    if (blockedToolCallIds.delete(event.toolCallId)) {
      toolCallIds.add(event.toolCallId);
      return {
        details: { ...record(event.details), localBudgetBlocked: true },
      };
    }
    if (toolCallIds.has(event.toolCallId)) return;

    toolCallIds.add(event.toolCallId);
    creditsUsed += creditsForFirecrawlResult(
      event.toolName,
      event.details,
      event.input,
      event.isError,
    );
    publish();
  });

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    creditsUsed = 0;
    budget = DEFAULT_FIRECRAWL_BUDGET;
    unlimited = false;
    toolCallIds.clear();
    reservations.clear();
    blockedToolCallIds.clear();
  });
}
