import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HERDR_BLOCKED_CHANNEL = "herdr:blocked";

export async function withHerdrBlocked<T>(
  pi: ExtensionAPI,
  label: string,
  operation: () => Promise<T>,
) {
  pi.events.emit(HERDR_BLOCKED_CHANNEL, { active: true, label });
  try {
    return await operation();
  } finally {
    pi.events.emit(HERDR_BLOCKED_CHANNEL, { active: false });
  }
}
