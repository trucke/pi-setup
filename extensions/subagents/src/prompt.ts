/** Model-facing strings for the subagent tools. */
import { EXECUTION_PROFILES } from "./profiles.ts";

const profileDescriptions = Object.entries(EXECUTION_PROFILES)
  .map(([name, profile]) => `${name} (${profile.description})`)
  .join("; ");

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION = `Spawn a background subagent using a release-pinned profile. Profiles: ${profileDescriptions}. Each profile fixes the harness, model, effort and role instructions, with no automatic fallback. To choose Claude, Pi, Codex or a specific model, use subagent-spawn-direct instead. Role instructions are not sandbox boundaries; child tool access is unchanged. Results arrive automatically or through subagent-wait. Children cannot see the parent conversation or ask the user. Max 4 active runs across both spawn tools.`;

export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent using a named profile with a fixed model and role";

export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent-spawn for self-contained work that benefits from an independent context; include all required paths, constraints, and expected output.",
  "Use subagent-spawn only when isolation, parallel work, sustained investigation or independent assessment justifies the handoff. Keep trivial work with the parent and prefer one child owning a coherent outcome over routine agent pipelines.",
  "For subagent-spawn, choose the profile whose scope matches the task. When the user requests Claude, Pi, Codex or a specific model, use subagent-spawn-direct instead.",
  "With subagent-spawn profile review, describe the exact artifact in prompt or supply an explicit code reviewTarget. Omitting reviewTarget never implies Git changes. Failures and scope escalation return to the parent; do not silently launch a replacement writer.",
  "After subagent-spawn, continue useful work. Results arrive automatically; use subagent-wait only when progress depends on them.",
];

export const SUBAGENT_DIRECT_TOOL_DESCRIPTION =
  'Spawn a background subagent on an explicit harness: "claude", "pi" or "codex". Use this when the user asks for Claude or another specific harness/model. Example: {"name":"Claude evaluation","harness":"claude","prompt":"Evaluate the design. Report findings; do not edit."}. No profile or reviewTarget fields: include the role, scope and constraints in prompt. Omit model and reasoningEffort, or set them to null, unless a particular setting is needed. Direct runs do not inherit profile instructions. Children cannot see the parent conversation or ask the user. Results arrive automatically or through subagent-wait. Max 4 active runs across both spawn tools.';

export const SUBAGENT_DIRECT_PROMPT_SNIPPET =
  "Spawn a background subagent on explicit Claude Code, Pi or Codex settings";

export const SUBAGENT_DIRECT_PROMPT_GUIDELINES = [
  "Use subagent-spawn-direct when a specific harness or model is requested. Include a self-contained task, paths, constraints and expected output; direct runs have no profile contract.",
  "Use subagent-spawn-direct only when independent or substantial work justifies delegation. For a Claude evaluation, set harness to claude and put read-only scope in prompt; do not add profile or reviewTarget.",
  "After subagent-spawn-direct, continue useful work. Results arrive automatically; use subagent-wait only when progress depends on them. Do not repeat a failed call unchanged; correct its arguments or report the blocker.",
];

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Self-contained task prompt, including required context, paths, constraints, and expected report",
  name: "Short human-readable run name shown in listings and the UI",
  profile:
    "Required profile. Fixes the harness, model, effort and role instructions",
  harness:
    'Direct harness: "pi" (in-process Pi), "claude" (Claude Code), or "codex" (Codex CLI)',
  workingDir:
    "Trusted working directory for the autonomous child. Omit or use null for the current working directory.",
  model:
    'Optional model (Pi: "provider/model-id"; Claude: alias/id; Codex: slug). Omit or use null to inherit the parent model for Pi or use the harness default for Claude/Codex.',
  reasoningEffort:
    "Optional reasoning effort. Omit or use null for the parent effort in Pi or harness defaults in Claude/Codex. Supported levels depend on the harness/model.",
  reviewTarget:
    'Use null or omit unless profile is "review" AND the task explicitly requests a code-change review. For research, scouting, documents, plans or interfaces, use null and describe scope in prompt. Never invent a Git target.',
};

export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  profile?: string;
  artifactPath?: string;
  artifactError?: string;
}) {
  const selection = options.profile
    ? `profile ${options.profile} → ${options.harness}: ${options.modelLabel}`
    : `${options.harness}: ${options.modelLabel}`;
  return (
    `Spawned subagent ${options.id} "${options.title}" (${selection}, ${options.cwd}).\n` +
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
