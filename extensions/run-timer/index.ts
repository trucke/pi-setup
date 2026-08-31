import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "run-timer-result";

export interface RunTimerEntryData {
  readonly durationMs: number;
}

/**
 * Injection points so tests can drive time deterministically. Production uses
 * a monotonic clock so a wall-clock adjustment mid-run cannot skew the display.
 */
export interface RunTimerDeps {
  readonly now: () => number;
}

const defaultDeps: RunTimerDeps = {
  now: () => performance.now(),
};

export function formatDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0)
    return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export default function (pi: ExtensionAPI, deps: RunTimerDeps = defaultDeps) {
  let startedAt: number | undefined;

  const elapsed = () => (startedAt === undefined ? 0 : deps.now() - startedAt);

  pi.registerEntryRenderer<RunTimerEntryData>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const duration = entry.data?.durationMs;
      const formatted =
        typeof duration === "number" ? formatDuration(duration) : "unknown";
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("dim", "Worked for")} ${theme.fg("accent", formatted)}`,
        1,
        0,
      );
    },
  );

  // A busy period spans agent_start → agent_settled. Retries, compaction
  // recovery, and queued continuations emit further agent_start events before
  // settling, so only the first one after idle begins a new run.
  pi.on("agent_start", () => {
    startedAt ??= deps.now();
  });

  pi.on("agent_settled", () => {
    if (startedAt === undefined) return;
    const durationMs = elapsed();
    startedAt = undefined;
    pi.appendEntry<RunTimerEntryData>(ENTRY_TYPE, { durationMs });
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
  });
}
