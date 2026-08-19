export const FIRECRAWL_USAGE_CHANNEL = "dashboard:firecrawl-usage";
export const REFRESH_CHANNEL = "dashboard:refresh";
export const DEFAULT_FIRECRAWL_BUDGET = 20;

export interface FirecrawlUsageState {
  creditsUsed: number;
  budget: number;
  unlimited: boolean;
}

export function emptyFirecrawlUsageState(): FirecrawlUsageState {
  return {
    creditsUsed: 0,
    budget: DEFAULT_FIRECRAWL_BUDGET,
    unlimited: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFirecrawlUsageState(
  value: unknown,
): value is FirecrawlUsageState {
  if (!isRecord(value)) return false;

  return (
    typeof value.creditsUsed === "number" &&
    Number.isFinite(value.creditsUsed) &&
    value.creditsUsed >= 0 &&
    typeof value.budget === "number" &&
    Number.isFinite(value.budget) &&
    value.budget > 0 &&
    typeof value.unlimited === "boolean"
  );
}
