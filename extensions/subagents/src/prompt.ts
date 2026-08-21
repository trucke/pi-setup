/** Model-facing strings for the subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent using either a release-pinned execution profile or explicit harness/model settings. Profiles: scout (read-only repository exploration), worker (implementation), reviewer (native code review), and oracle (deep technical analysis). Profile and direct execution settings are mutually exclusive. Role prompts such as scout/reviewer inspect-only behavior are not sandbox boundaries; every child retains its harness's normal host permissions. Fire-and-forget: results arrive automatically or can be collected with subagent-wait. Children cannot see the parent conversation or ask the user. Max 4 runs can be active at once; profile fallbacks happen only before meaningful model or tool activity.";

export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent through a focused profile or explicit Pi, Claude Code, or Codex settings";

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent-spawn for self-contained work that benefits from an independent context; include all required paths, constraints, and expected output.",
  "Prefer a subagent-spawn profile when scout, worker, reviewer, or oracle semantics fit; use direct execution only when a specific harness or model is required.",
  "After subagent-spawn, continue useful work. Results arrive automatically; use subagent-wait only when progress depends on them.",
];

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Self-contained task prompt, including required context, paths, constraints, and expected report",
  name: "Short human-readable run name shown in listings and the UI",
  profile: "Release-pinned execution profile",
  harness:
    'Direct harness: "pi" (in-process Pi), "claude" (Claude Code), or "codex" (Codex CLI)',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Direct model hint (Pi: "provider/model-id"; Claude: model alias/id; Codex: model slug)',
  reasoningEffort:
    "Direct reasoning effort on the shared off/minimal/low/medium/high/xhigh/max scale",
  reviewTarget:
    "Reviewer target. Defaults to uncommitted changes; commits and pull requests must be explicit.",
};

export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  profile?: string;
  attempts?: number;
  artifactPath?: string;
  artifactError?: string;
}) {
  const selection = options.profile
    ? `profile ${options.profile} → ${options.harness}: ${options.modelLabel}`
    : `${options.harness}: ${options.modelLabel}`;
  const fallback =
    options.attempts && options.attempts > 1
      ? ` after ${options.attempts - 1} unavailable candidate(s)`
      : "";
  return (
    `Spawned subagent ${options.id} "${options.title}" (${selection}${fallback}, ${options.cwd}).\n` +
    `It runs in the background. Use subagent-send to steer it, subagent-wait to collect it, or subagent-check to inspect it.` +
    (options.artifactPath
      ? `\nDurable artifacts: ${options.artifactPath}`
      : options.artifactError
        ? `\nWarning: ${options.artifactError}`
        : "")
  );
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  'Wait until all or any listed runs settle. An optional timeout stops waiting without cancelling work. Defaults to mode "all" and no timeout.';

export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids, e.g. ["sa-ab12cd34", "sa-ef56ab78"]',
  mode: '"all" waits for every id; "any" returns once at least one settles',
  timeoutMs:
    "Optional wait deadline in milliseconds. Timing out leaves runs active.",
};

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel running subagents while preserving partial output and durable recovery artifacts.";

export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: "Subagent ids to cancel",
};

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send guidance to a subagent. The receipt explicitly reports whether the message was delivered, queued for a later turn, or unsupported.";

export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
  message: "Guidance or continuation message",
};

export const SUBAGENT_RESUME_TOOL_DESCRIPTION =
  "Explicitly resume a recovered run. Auto mode prefers the native backend session; continuation mode can deliberately bypass a stale native id and start from the persisted partial output. Recovery never starts automatically.";

export const SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS = {
  id: "Recoverable subagent id",
  prompt: "Continuation instruction for the recovered run",
  mode: 'Recovery mode: "auto" (prefer native), "native", or "continuation" (use persisted partial output)',
};

export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Inspect status, factual liveness, current tools, usage, recovery state, and recent output without blocking.";

export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List tracked and recovered subagents together with backend readiness.";

export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "done" | "failed" | "cancelled";
  errorText?: string;
  output: string;
  artifactPath?: string;
}) {
  const verb =
    options.status === "done"
      ? "finished"
      : options.status === "cancelled"
        ? "was cancelled"
        : "failed";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  if (options.artifactPath) text += `\n\nArtifact: ${options.artifactPath}`;
  return text;
}
