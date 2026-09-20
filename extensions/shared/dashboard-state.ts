export const FIRECRAWL_USAGE_CHANNEL = "dashboard:firecrawl-usage";
export const REFRESH_CHANNEL = "dashboard:refresh";
export const DEFAULT_FIRECRAWL_BUDGET = 20;

/** Developer Search estimates only, not provider billing receipts. */
export interface FirecrawlUsageState {
  unitsUsed: number;
  anonymousUnits: number;
  accountCredits: number;
  budget: number;
  unlimited: boolean;
}

export function emptyFirecrawlUsageState(): FirecrawlUsageState {
  return {
    unitsUsed: 0,
    anonymousUnits: 0,
    accountCredits: 0,
    budget: DEFAULT_FIRECRAWL_BUDGET,
    unlimited: false,
  };
}

export function isFirecrawlUsageState(
  value: unknown,
): value is FirecrawlUsageState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    [state.unitsUsed, state.anonymousUnits, state.accountCredits].every(
      (number) =>
        typeof number === "number" && Number.isFinite(number) && number >= 0,
    ) &&
    typeof state.budget === "number" &&
    Number.isFinite(state.budget) &&
    state.budget > 0 &&
    typeof state.unlimited === "boolean"
  );
}
