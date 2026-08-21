import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ArtifactPaths,
  RecoveryState,
  SubagentSnapshot,
} from "./domain.ts";
import { latestText } from "./domain.ts";

const RECEIPT_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PERSISTED_TRANSCRIPT_ITEMS = 64;
const PERSISTED_TEXT_LENGTH = 8 * 1024;
const PERSISTED_PREVIEW_LENGTH = 4 * 1024;
const PERSISTED_FINAL_TEXT_LENGTH = 256 * 1024;
const RUN_DIRECTORY_PATTERN = /^(?:sa|btw)-[0-9a-f]{8}$/;

export function stateRoot() {
  return (
    process.env.PI_SUBAGENT_STATE_DIR ??
    path.join(getAgentDir(), "state", "subagents")
  );
}

export function createRunId(origin: SubagentSnapshot["origin"]) {
  const prefix = origin === "btw" ? "btw" : "sa";
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function createArtifactPaths(id: string): ArtifactPaths {
  const directory = path.join(stateRoot(), id);
  return {
    directory,
    receipt: path.join(directory, "receipt.json"),
    snapshot: path.join(directory, "snapshot.json"),
    transcript: path.join(directory, "transcript.jsonl"),
    output: path.join(directory, "output.md"),
  };
}

function atomicWrite(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIRECTORY_MODE });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: FILE_MODE });
  fs.renameSync(temporary, file);
}

function recoveryFor(snapshot: SubagentSnapshot): RecoveryState {
  if (snapshot.status === "running") return { available: false };
  if (
    (snapshot.backend === "pi" && snapshot.meta.sessionFilePath) ||
    (snapshot.backend !== "pi" && snapshot.meta.nativeSessionId)
  ) {
    return { available: true, mode: "native" };
  }
  if (latestText(snapshot).trim()) {
    return { available: true, mode: "continuation" };
  }
  return {
    available: false,
    reason: "No native session or partial output is available.",
  };
}

function outputMarkdown(snapshot: SubagentSnapshot) {
  const selected = snapshot.execution.selected;
  const lines = [
    `# ${snapshot.id}: ${snapshot.title}`,
    "",
    `- Status: ${snapshot.status}`,
    `- Execution: ${snapshot.execution.requested.type === "profile" ? `profile ${snapshot.execution.requested.profile}` : "direct"}`,
    `- Harness: ${snapshot.backend}`,
    `- Model: ${snapshot.meta.modelLabel ?? selected.model ?? "default"}`,
    `- Reasoning effort: ${selected.reasoningEffort ?? "backend default"}`,
    `- Run mode: ${selected.runMode}`,
    `- Working directory: ${snapshot.cwd}`,
    `- Started: ${new Date(snapshot.startedAt).toISOString()}`,
    `- Last activity: ${new Date(snapshot.lastActivityAt).toISOString()}`,
    snapshot.settledAt
      ? `- Settled: ${new Date(snapshot.settledAt).toISOString()}`
      : "",
    snapshot.errorText ? `- Error: ${snapshot.errorText}` : "",
    "",
    "## Output",
    "",
    latestText(snapshot).trim() || "(no text output)",
    "",
  ];
  return lines
    .filter((line, index) => line || lines[index - 1] !== "")
    .join("\n");
}

function boundedPersistedSnapshot(snapshot: SubagentSnapshot) {
  const transcript = snapshot.transcript
    .slice(-PERSISTED_TRANSCRIPT_ITEMS)
    .map((item) => {
      if (item.kind === "user") {
        return { ...item, text: item.text.slice(-PERSISTED_TEXT_LENGTH) };
      }
      if (item.kind === "toolResult") {
        return {
          ...item,
          outputPreview: item.outputPreview?.slice(-PERSISTED_PREVIEW_LENGTH),
        };
      }
      return {
        ...item,
        parts: item.parts.map((part) =>
          part.type === "toolCall"
            ? {
                ...part,
                argsPreview: part.argsPreview?.slice(-PERSISTED_PREVIEW_LENGTH),
              }
            : { ...part, text: part.text.slice(-PERSISTED_TEXT_LENGTH) },
        ),
      };
    });
  return {
    ...snapshot,
    transcript,
    finalText: snapshot.finalText.slice(0, PERSISTED_FINAL_TEXT_LENGTH),
  } satisfies SubagentSnapshot;
}

export function persistSnapshot(snapshot: SubagentSnapshot) {
  const recovery = recoveryFor(snapshot);
  const persisted = {
    ...boundedPersistedSnapshot(snapshot),
    recovery,
  } satisfies SubagentSnapshot;
  const receipt = {
    version: RECEIPT_VERSION,
    id: persisted.id,
    origin: persisted.origin,
    title: persisted.title,
    status: persisted.status,
    startedAt: persisted.startedAt,
    lastActivityAt: persisted.lastActivityAt,
    lastEvent: persisted.lastEvent,
    currentTools: persisted.currentTools,
    settledAt: persisted.settledAt,
    errorText: persisted.errorText,
    backend: persisted.backend,
    cwd: persisted.cwd,
    parentCwd: persisted.parentCwd,
    parentSessionId: persisted.parentSessionId,
    execution: persisted.execution,
    reviewTarget: persisted.reviewTarget,
    meta: persisted.meta,
    usage: persisted.usage,
    recovery,
    artifacts: persisted.artifacts,
  };
  atomicWrite(
    persisted.artifacts.receipt,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  atomicWrite(
    persisted.artifacts.snapshot,
    `${JSON.stringify(persisted, null, 2)}\n`,
  );
  const transcript = persisted.transcript
    .map((item) => JSON.stringify(item))
    .join("\n");
  atomicWrite(
    persisted.artifacts.transcript,
    transcript ? `${transcript}\n` : "",
  );
  atomicWrite(
    persisted.artifacts.output,
    outputMarkdown({ ...snapshot, recovery }),
  );
  return recovery;
}

export function tryPersistSnapshot(snapshot: SubagentSnapshot) {
  try {
    return persistSnapshot(snapshot);
  } catch (error) {
    return {
      available: false,
      reason:
        `Failed to persist recovery artifacts: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          1_024,
        ),
    } satisfies RecoveryState;
  }
}

function isTranscriptItem(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const item = value as {
    kind?: unknown;
    text?: unknown;
    parts?: unknown;
    toolId?: unknown;
    name?: unknown;
    isError?: unknown;
  };
  if (item.kind === "user") return typeof item.text === "string";
  if (item.kind === "toolResult") {
    return (
      typeof item.toolId === "string" &&
      typeof item.name === "string" &&
      typeof item.isError === "boolean"
    );
  }
  if (item.kind !== "assistant" || !Array.isArray(item.parts)) return false;
  return item.parts.every((part) => {
    if (!part || typeof part !== "object") return false;
    const candidate = part as {
      type?: unknown;
      text?: unknown;
      toolId?: unknown;
      name?: unknown;
    };
    return candidate.type === "toolCall"
      ? typeof candidate.toolId === "string" &&
          typeof candidate.name === "string"
      : (candidate.type === "text" || candidate.type === "thinking") &&
          typeof candidate.text === "string";
  });
}

function isSnapshot(value: unknown): value is SubagentSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SubagentSnapshot>;
  const execution = candidate.execution as
    { selected?: unknown; attempts?: unknown; requested?: unknown } | undefined;
  const selected = execution?.selected as
    { harness?: unknown; runMode?: unknown } | undefined;
  const requested = execution?.requested as
    { type?: unknown; profile?: unknown } | undefined;
  return (
    typeof candidate.id === "string" &&
    (candidate.origin === "model" || candidate.origin === "btw") &&
    (candidate.backend === "pi" ||
      candidate.backend === "claude" ||
      candidate.backend === "codex") &&
    typeof candidate.title === "string" &&
    typeof candidate.prompt === "string" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.parentCwd === "string" &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.lastActivityAt === "number" &&
    typeof candidate.finalText === "string" &&
    typeof candidate.turns === "number" &&
    (candidate.status === "running" ||
      candidate.status === "done" ||
      candidate.status === "failed" ||
      candidate.status === "cancelled") &&
    Array.isArray(candidate.transcript) &&
    candidate.transcript.every(isTranscriptItem) &&
    !!candidate.meta &&
    typeof candidate.meta === "object" &&
    !!candidate.usage &&
    typeof candidate.usage === "object" &&
    (selected?.harness === "pi" ||
      selected?.harness === "claude" ||
      selected?.harness === "codex") &&
    (selected.runMode === "agent" ||
      selected.runMode === "review" ||
      selected.runMode === "code-review") &&
    (requested?.type === "direct" ||
      (requested?.type === "profile" &&
        (requested.profile === "scout" ||
          requested.profile === "worker" ||
          requested.profile === "reviewer" ||
          requested.profile === "oracle"))) &&
    Array.isArray(execution?.attempts)
  );
}

export function recoverPersistedSnapshot(snapshot: SubagentSnapshot) {
  if (snapshot.status !== "running") {
    return {
      ...snapshot,
      lastEvent: "Recovered" as const,
      liveAssistant: undefined,
      liveTools: [],
      currentTools: [],
      queued: [],
      recovery: recoveryFor(snapshot),
    } satisfies SubagentSnapshot;
  }
  const partialText = latestText(snapshot);
  const provisional = {
    ...snapshot,
    status: "cancelled" as const,
    errorText: "Parent session ended before the run settled.",
    settledAt: Date.now(),
    lastEvent: "Recovered" as const,
    finalText: snapshot.finalText || partialText,
    liveAssistant: undefined,
    liveTools: [],
    currentTools: [],
    queued: [],
    recovery: { available: false },
  } satisfies SubagentSnapshot;
  return {
    ...provisional,
    recovery: recoveryFor(provisional),
  } satisfies SubagentSnapshot;
}

export function loadPersistedSnapshots() {
  let names: string[];
  try {
    names = fs.readdirSync(stateRoot());
  } catch {
    return [];
  }

  const loaded: SubagentSnapshot[] = [];
  for (const name of names) {
    const artifacts = createArtifactPaths(name);
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(artifacts.snapshot, "utf8"),
      );
      if (!isSnapshot(parsed)) continue;
      loaded.push({ ...parsed, artifacts });
    } catch {
      // Ignore incomplete or incompatible artifacts. A bad receipt must not
      // prevent the extension from loading other recoverable runs.
    }
  }

  loaded.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return loaded;
}

export function pruneArtifacts(limit: number) {
  let directories: Array<{
    name: string;
    activityAt: number;
    status: SubagentSnapshot["status"];
  }>;
  try {
    directories = fs
      .readdirSync(stateRoot(), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && RUN_DIRECTORY_PATTERN.test(entry.name),
      )
      .flatMap((entry) => {
        const directory = path.join(stateRoot(), entry.name);
        try {
          const snapshot: unknown = JSON.parse(
            fs.readFileSync(path.join(directory, "snapshot.json"), "utf8"),
          );
          if (!isSnapshot(snapshot) || snapshot.id !== entry.name) return [];
          return [
            {
              name: entry.name,
              activityAt: snapshot.lastActivityAt,
              status: snapshot.status,
            },
          ];
        } catch {
          // Never recursively remove an unvalidated or incomplete directory.
          return [];
        }
      })
      .sort((a, b) => b.activityAt - a.activityAt);
  } catch {
    return;
  }

  // Running receipts may belong to this process or another live Pi process
  // sharing the state root. Retention never deletes them; interrupted stale
  // receipts become eligible after an explicit restore marks them terminal.
  const settled = directories.filter((entry) => entry.status !== "running");
  for (const entry of settled.slice(limit)) {
    try {
      fs.rmSync(path.join(stateRoot(), entry.name), {
        recursive: true,
        force: true,
      });
    } catch {
      // Retention cleanup is best-effort.
    }
  }
}
