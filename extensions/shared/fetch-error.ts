export type FetchFailureCategory =
  | "unsafe"
  | "invalid"
  | "cancelled"
  | "timeout"
  | "network"
  | "http"
  | "content"
  | "redirect"
  | "unknown";

/** Structured policy metadata, never inferred from error messages. */
export class FetchError extends Error {
  readonly category: FetchFailureCategory;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    category: FetchFailureCategory,
    status?: number,
    code?: string,
  ) {
    super(message);
    this.category = category;
    this.status = status;
    this.code = code;
  }

  get recoverable() {
    return (
      ["timeout", "network", "http", "content"].includes(this.category) &&
      this.status !== 401 &&
      this.status !== 403
    );
  }
}

export const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);
