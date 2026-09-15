import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import {
  createArtifactPaths,
  createRunId,
  loadPersistedSnapshots,
  pruneArtifacts,
  recoverPersistedSnapshot,
  tryPersistSnapshot,
} from "./artifacts.ts";
import type {
  BackendReadiness,
  SubagentBackend,
  SubagentSession,
} from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  ParentContext,
  RunOutcome,
  SendReceipt,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  latestText,
  ResumeError,
  SendError,
  SpawnError,
} from "./domain.ts";

import { buildReviewPrompt } from "./review.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;
const RECOVERY_CONTEXT_MAX_LENGTH = 64 * 1024;
const PERSIST_DEBOUNCE_MS = 1_000;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

interface MutableSnapshot {
  id: string;
  origin: SubagentSnapshot["origin"];
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  parentCwd: string;
  parentSessionId?: string;
  status: SubagentStatus;
  startedAt: number;
  lastActivityAt: number;
  lastEvent: SubagentSnapshot["lastEvent"];
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: SubagentSnapshot["usage"];
  execution: SubagentSnapshot["execution"];
  reviewTarget?: SubagentSnapshot["reviewTarget"];
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  currentTools: string[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
  artifacts: SubagentSnapshot["artifacts"];
  recovery: SubagentSnapshot["recovery"];
}

interface Entry {
  snapshot: MutableSnapshot;
  session?: SubagentSession;
  scope?: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  cancelRequested?: boolean;
  resuming?: boolean;
  restarting?: boolean;
  persistTimer?: ReturnType<typeof setTimeout>;
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestSend(id: string, text: string): void;
  requestAbort(id: string): void;
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface WaitResult {
  readonly settledIds: ReadonlyArray<string>;
  /** Detached receipts captured before retention interest is released. */
  readonly settledSnapshots: ReadonlyArray<SubagentSnapshot>;
  readonly pendingIds: ReadonlyArray<string>;
  readonly timedOut: boolean;
}

export interface ResumeResult {
  readonly snapshot: SubagentSnapshot;
  readonly mode: "native" | "continuation";
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  restore(
    parentSessionId: string | undefined,
    parentCwd: string,
  ): Effect.Effect<number>;
  resume(
    id: string,
    prompt: string,
    parent: ParentContext,
    mode?: "auto" | "native" | "continuation",
  ): Effect.Effect<
    ResumeResult,
    ResumeError | SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  waitFor(
    ids: ReadonlyArray<string>,
    mode?: "all" | "any",
    onPending?: (pending: string[]) => void,
    timeoutMs?: number,
  ): Effect.Effect<WaitResult>;
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<SendReceipt, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly readiness: Effect.Effect<ReadonlyArray<BackendReadiness>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  /** Runs whose settlement should count as consumed by an active wait. */
  const waitInterest = new Map<string, number>();
  /** Runs protected from in-memory pruning while any wait references them. */
  const retentionInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  let changeWaiters: Array<() => void> = [];
  let changeVersion = 0;
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let reserved = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    changeVersion++;
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Rendering/status listeners cannot corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  const nextChange = (observedVersion: number) =>
    Effect.suspend(() => {
      if (changeVersion !== observedVersion) return Effect.void;
      return Effect.callback<void>((resume) => {
        const waiter = () => {
          const index = changeWaiters.indexOf(waiter);
          if (index >= 0) changeWaiters.splice(index, 1);
          resume(Effect.void);
        };
        changeWaiters.push(waiter);
        // Close the check/register race: a notification between Effect.suspend
        // and waiter registration must not leave this fiber asleep forever.
        if (changeVersion !== observedVersion) waiter();
        return Effect.sync(() => {
          const index = changeWaiters.indexOf(waiter);
          if (index >= 0) changeWaiters.splice(index, 1);
        });
      });
    });

  const nextChangeWithin = (observedVersion: number, timeoutMs: number) =>
    Effect.suspend(() => {
      if (changeVersion !== observedVersion) return Effect.void;
      return Effect.callback<void>((resume) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const index = changeWaiters.indexOf(waiter);
          if (index >= 0) changeWaiters.splice(index, 1);
          resume(Effect.void);
        };
        const waiter = finish;
        const timer = setTimeout(finish, timeoutMs);
        changeWaiters.push(waiter);
        if (changeVersion !== observedVersion) waiter();
        return Effect.sync(() => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const index = changeWaiters.indexOf(waiter);
          if (index >= 0) changeWaiters.splice(index, 1);
        });
      });
    });

  const persistNow = (entry: Entry) => {
    if (entry.persistTimer) clearTimeout(entry.persistTimer);
    entry.persistTimer = undefined;
    entry.snapshot.recovery = tryPersistSnapshot(
      entry.snapshot as SubagentSnapshot,
    );
  };

  const schedulePersist = (entry: Entry) => {
    if (entry.persistTimer) return;
    entry.persistTimer = setTimeout(
      () => persistNow(entry),
      PERSIST_DEBOUNCE_MS,
    );
    entry.persistTimer.unref?.();
  };

  const runningCount = () =>
    [...entries.values()].filter(
      (entry) =>
        entry.snapshot.status === "running" || entry.restarting === true,
    ).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };

  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const addRetentionInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      retentionInterest.set(id, (retentionInterest.get(id) ?? 0) + 1);
    }
  };

  const releaseRetentionInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (retentionInterest.get(id) ?? 1) - 1;
      if (count <= 0) retentionInterest.delete(id);
      else retentionInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    entry.scope
      ? Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
      : Effect.void;

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (entry) =>
          entry.snapshot.status !== "running" &&
          !waitInterest.has(entry.snapshot.id) &&
          !retentionInterest.has(entry.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.startedAt) -
          (b.snapshot.settledAt ?? b.snapshot.startedAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      persistNow(entry);
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
    pruneArtifacts(MAX_TRACKED);
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const snapshot = entry.snapshot;
    entry.restarting = false;
    entry.resuming = false;
    if (snapshot.status !== "running") return;
    const now = Date.now();
    snapshot.lastActivityAt = now;
    snapshot.lastEvent = "RunSettled";
    snapshot.settledAt = now;
    switch (outcome._tag) {
      case "Completed":
        snapshot.status = "done";
        snapshot.errorText = undefined;
        snapshot.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        snapshot.status = "failed";
        snapshot.errorText = bounded(outcome.errorText);
        snapshot.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
      case "Interrupted":
        snapshot.status = "cancelled";
        snapshot.errorText = "Run was cancelled";
        snapshot.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
    }
    snapshot.liveAssistant = undefined;
    entry.liveToolMap.clear();
    snapshot.liveTools = [];
    snapshot.currentTools = [];
    snapshot.queued = [];
    persistNow(entry);
    pruneArtifacts(MAX_TRACKED);
    const consumed = (waitInterest.get(snapshot.id) ?? 0) > 0;
    notify(snapshot.id);
    try {
      if (!disposed) onSettled?.(snapshot, consumed);
    } catch {
      // The parent session may already be unavailable.
    }
    pruneSettled();
  };

  const scheduleEntryCleanup = (entry: Entry) => {
    const fiber = runDetached(
      closeEntryScope(entry).pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.ignore,
      ),
    );
    cleanups.add(fiber);
    fiber.addObserver(() => cleanups.delete(fiber));
  };

  const rejectRun = (
    entry: Entry,
    rejection: Extract<SubagentEvent, { _tag: "RunRejected" }>,
  ) => {
    if (entry.snapshot.status !== "running") return;
    const partialText = latestText(entry.snapshot) || undefined;
    settle(
      entry,
      entry.cancelRequested
        ? { _tag: "Interrupted", partialText }
        : {
            _tag: "Failed",
            errorText: `${rejection.reason}: ${rejection.message}`,
            partialText,
          },
    );
    scheduleEntryCleanup(entry);
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const snapshot = entry.snapshot;
    snapshot.lastActivityAt = Date.now();
    snapshot.lastEvent = event._tag;
    switch (event._tag) {
      case "RunStarted":
        if (
          entry.cancelRequested ||
          (snapshot.status !== "running" && !entry.restarting)
        ) {
          return;
        }
        entry.restarting = false;
        entry.cancelRequested = false;
        snapshot.status = "running";
        snapshot.settledAt = undefined;
        snapshot.errorText = undefined;
        snapshot.recovery = { available: false };
        break;
      case "RunRejected":
        rejectRun(entry, event);
        return;
      case "RunSettled":
        settle(entry, event.outcome);
        return;
      case "UserMessage":
        appendTranscript(snapshot, {
          kind: "user",
          text: boundedTranscriptText(event.text),
        });
        break;
      case "AssistantDelta": {
        const live = snapshot.liveAssistant ?? { text: "", thinking: "" };
        snapshot.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              };
        break;
      }
      case "AssistantMessage":
        appendTranscript(snapshot, {
          kind: "assistant",
          parts: event.parts.map((part) =>
            part.type === "toolCall"
              ? {
                  ...part,
                  argsPreview: part.argsPreview
                    ? boundedTranscriptText(part.argsPreview)
                    : undefined,
                }
              : { ...part, text: boundedTranscriptText(part.text) },
          ),
        });
        snapshot.liveAssistant = undefined;
        snapshot.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        });
        snapshot.liveTools = [...entry.liveToolMap.values()];
        snapshot.currentTools = snapshot.liveTools.map((tool) => tool.name);
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          snapshot.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        snapshot.liveTools = [...entry.liveToolMap.values()];
        snapshot.currentTools = snapshot.liveTools.map((tool) => tool.name);
        appendTranscript(snapshot, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        });
        break;
      case "QueueChanged":
        snapshot.queued = event.queued;
        break;
      case "UsageChanged":
        snapshot.usage = { ...snapshot.usage, ...event.usage };
        break;
      case "MetaChanged":
        snapshot.meta = { ...snapshot.meta, ...event.meta };
        break;
      case "BackendError":
        snapshot.errorText = bounded(event.message);
        break;
    }
    schedulePersist(entry);
    notify(snapshot.id);
  };

  const startPump = (
    entry: Entry,
    session: SubagentSession,
    scope: Scope.Closeable,
  ) =>
    Effect.gen(function* () {
      if (
        entry.snapshot.status !== "running" ||
        entry.cancelRequested === true
      ) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        return false;
      }
      entry.session = session;
      entry.scope = scope;
      const pump = Stream.runForEach(session.events, (event) =>
        Effect.sync(() => foldEvent(entry, event)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.snapshot.status === "running") {
              settle(entry, {
                _tag: "Failed",
                errorText: "Backend event stream ended unexpectedly",
              });
            }
            // Clear only the session owned by this exact scope.
            if (entry.scope === scope) {
              entry.session = undefined;
              entry.scope = undefined;
              entry.pump = undefined;
            }
          }),
        ),
      );
      entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
      return true;
    });

  const reserve = () =>
    Effect.suspend(
      (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
        if (disposed) {
          return new SpawnError({
            message: "Subagent manager is shutting down.",
          });
        }
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new ConcurrencyLimitError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
          });
        }
        reserved++;
        return Effect.void;
      },
    );

  const getReadyBackend = (backendName: BackendName) =>
    Effect.gen(function* () {
      const backend: SubagentBackend | undefined = registry.get(backendName);
      if (!backend) {
        return yield* new BackendUnavailableError({
          message: `Unknown backend "${backendName}".`,
        });
      }
      const readiness = yield* backend.readiness;
      if (!readiness.ready) {
        return yield* new BackendUnavailableError({
          message: `Backend "${backendName}" is unavailable: ${readiness.detail}.`,
        });
      }
      return backend;
    });

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    Effect.gen(function* () {
      yield* reserve();
      let unattachedScope: Scope.Closeable | undefined;
      let pendingEntry: Entry | undefined;
      const work = Effect.gen(function* () {
        const backend = yield* getReadyBackend(backendName);
        const scope = yield* Scope.make();
        unattachedScope = scope;
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        if (disposed) {
          yield* Scope.close(scope, Exit.void);
          unattachedScope = undefined;
          return yield* new SpawnError({
            message: "Subagent manager shut down while spawning.",
          });
        }

        const origin = task.origin ?? "model";
        const id = createRunId(origin);
        const meta = yield* session.meta;
        const selected = {
          harness: backendName,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          runMode: task.runMode ?? "agent",
        } as const;
        const now = Date.now();
        const entry: Entry = {
          snapshot: {
            id,
            origin,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            parentCwd: task.parent.parentCwd,
            parentSessionId: task.parent.parentSessionId,
            status: "running",
            startedAt: now,
            lastActivityAt: now,
            lastEvent: "RunStarted",
            meta,
            usage: { contextWindow: meta.contextWindow },
            reviewTarget: task.reviewTarget,
            execution: {
              requested: task.profile
                ? { type: "profile", profile: task.profile }
                : { type: "direct" },
              selected,
            },
            transcript: [],
            liveTools: [],
            currentTools: [],
            queued: [],
            finalText: "",
            turns: 0,
            artifacts: createArtifactPaths(id),
            recovery: { available: false },
          },
          liveToolMap: new Map(),
        };
        pendingEntry = entry;
        entries.set(id, entry);
        persistNow(entry);
        pruneArtifacts(MAX_TRACKED);
        const attached = yield* startPump(entry, session, scope);
        if (!attached) {
          unattachedScope = undefined;
          return yield* new SpawnError({
            message: "Subagent spawn was cancelled before attachment.",
          });
        }
        unattachedScope = undefined;
        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* work.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (unattachedScope) {
              if (pendingEntry?.snapshot.status === "running") {
                settle(pendingEntry, {
                  _tag: "Interrupted",
                  partialText: latestText(pendingEntry.snapshot) || undefined,
                });
                pendingEntry.snapshot.errorText =
                  "Spawn was interrupted before the backend attached";
                persistNow(pendingEntry);
              }
              yield* Scope.close(unattachedScope, Exit.void).pipe(
                Effect.timeout(STOP_TIMEOUT_MS),
                Effect.ignore,
              );
              unattachedScope = undefined;
            }
            reserved--;
            notify();
          }),
        ),
      );
    });

  const restore = (parentSessionId: string | undefined, parentCwd: string) =>
    Effect.sync(() => {
      pruneArtifacts(MAX_TRACKED);
      let restored = 0;
      const snapshots = loadPersistedSnapshots()
        .filter((snapshot) =>
          parentSessionId
            ? snapshot.parentSessionId === parentSessionId
            : snapshot.parentSessionId === undefined &&
              snapshot.parentCwd === parentCwd,
        )
        .slice(0, MAX_TRACKED);
      for (const persisted of snapshots) {
        if (entries.has(persisted.id)) continue;
        const snapshot = recoverPersistedSnapshot(persisted);
        const entry: Entry = {
          snapshot: {
            ...snapshot,
            transcript: [...snapshot.transcript],
          },
          liveToolMap: new Map(),
        };
        entries.set(snapshot.id, entry);
        if (persisted.status === "running") persistNow(entry);
        restored++;
      }
      if (restored > 0) notify();
      return restored;
    });

  const resume = (
    id: string,
    prompt: string,
    parent: ParentContext,
    modePreference: "auto" | "native" | "continuation" = "auto",
  ) =>
    Effect.gen(function* () {
      yield* reserve();
      let reservationHeld = true;
      let claimedEntry: Entry | undefined;
      let unattachedScope: Scope.Closeable | undefined;
      const work = Effect.gen(function* () {
        const entry = entries.get(id);
        if (!entry) {
          return yield* new ResumeError({
            message: `Subagent "${id}" is not tracked.`,
          });
        }
        if (entry.snapshot.status === "running" || entry.resuming) {
          return yield* new ResumeError({
            message: `Subagent "${id}" is already running or resuming.`,
          });
        }
        entry.resuming = true;
        entry.cancelRequested = false;
        claimedEntry = entry;
        if (entry.session) {
          return yield* new ResumeError({
            message: `Subagent "${id}" is still attached to this runtime; use subagent-send to continue it.`,
          });
        }
        if (
          !entry.snapshot.recovery.available ||
          !entry.snapshot.recovery.mode
        ) {
          return yield* new ResumeError({
            message:
              entry.snapshot.recovery.reason ??
              `Subagent "${id}" has no recoverable session or output.`,
          });
        }

        if (entry.scope) {
          yield* closeEntryScope(entry).pipe(
            Effect.timeout(STOP_TIMEOUT_MS),
            Effect.ignore,
          );
          entry.scope = undefined;
        }
        const backend = yield* getReadyBackend(entry.snapshot.backend);
        const detectedMode = entry.snapshot.recovery.mode;
        const mode = modePreference === "auto" ? detectedMode : modePreference;
        if (mode === "native" && detectedMode !== "native") {
          return yield* new ResumeError({
            message: `Subagent "${id}" has no native session to resume.`,
          });
        }
        if (mode === "continuation" && !entry.snapshot.finalText.trim()) {
          return yield* new ResumeError({
            message: `Subagent "${id}" has no partial output for an artifact-based continuation.`,
          });
        }
        const resumeSource =
          mode === "native"
            ? {
                mode,
                nativeSessionId: entry.snapshot.meta.nativeSessionId,
                sessionFilePath: entry.snapshot.meta.sessionFilePath,
              }
            : {
                mode,
                previousOutput: entry.snapshot.finalText,
              };
        const continuationPrompt = buildReviewPrompt(
          mode === "native"
            ? prompt
            : [
                "Continue a recovered subagent task using the existing workspace state.",
                `Original task:\n${entry.snapshot.prompt.slice(0, RECOVERY_CONTEXT_MAX_LENGTH)}`,
                `Previous partial output:\n${entry.snapshot.finalText.slice(0, RECOVERY_CONTEXT_MAX_LENGTH) || "(none)"}`,
                `Continuation request:\n${prompt}`,
              ].join("\n\n"),
          entry.snapshot.reviewTarget,
        );
        const selected = entry.snapshot.execution.selected;
        const task: SpawnTask = {
          prompt: continuationPrompt,
          title: entry.snapshot.title,
          cwd: entry.snapshot.cwd,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort,
          // Native review sessions continue as normal turns. The target above
          // also survives artifact recovery, which starts a fresh session.
          runMode: "agent",
          reviewTarget: entry.snapshot.reviewTarget,
          resume: resumeSource,
          parent,
        };
        const scope = yield* Scope.make();
        unattachedScope = scope;
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        if (disposed || entry.cancelRequested || !entry.resuming) {
          yield* Scope.close(scope, Exit.void);
          unattachedScope = undefined;
          entry.resuming = false;
          return yield* new ResumeError({
            message: disposed
              ? "Subagent manager shut down while resuming."
              : `Resume of subagent "${id}" was cancelled.`,
          });
        }
        // Atomically hand the concurrency slot from the reservation to the
        // now-running snapshot so this logical run is never counted twice.
        reserved--;
        reservationHeld = false;
        entry.resuming = false;
        entry.cancelRequested = false;
        entry.snapshot.status = "running";
        entry.snapshot.errorText = undefined;
        entry.snapshot.settledAt = undefined;
        entry.snapshot.lastActivityAt = Date.now();
        entry.snapshot.lastEvent = "RunStarted";
        entry.snapshot.recovery = { available: false };
        entry.liveToolMap.clear();
        const attached = yield* startPump(entry, session, scope);
        if (!attached) {
          unattachedScope = undefined;
          return yield* new ResumeError({
            message: `Resume of subagent "${id}" was cancelled before attachment.`,
          });
        }
        unattachedScope = undefined;
        persistNow(entry);
        notify(id);
        return { snapshot: entry.snapshot as SubagentSnapshot, mode };
      });

      return yield* work.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (unattachedScope) {
              if (claimedEntry?.snapshot.status === "running") {
                settle(claimedEntry, {
                  _tag: "Interrupted",
                  partialText: latestText(claimedEntry.snapshot) || undefined,
                });
                claimedEntry.snapshot.errorText =
                  "Resume was interrupted before the backend attached";
                persistNow(claimedEntry);
              }
              yield* Scope.close(unattachedScope, Exit.void).pipe(
                Effect.timeout(STOP_TIMEOUT_MS),
                Effect.ignore,
              );
              unattachedScope = undefined;
            }
            if (claimedEntry && claimedEntry.snapshot.status !== "running") {
              claimedEntry.resuming = false;
            }
            if (reservationHeld) reserved--;
            notify();
          }),
        ),
      );
    });

  const waitFor = (
    ids: ReadonlyArray<string>,
    mode: "all" | "any" = "all",
    onPending?: (pending: string[]) => void,
    timeoutMs?: number,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const deadline =
        timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      // Results settle into the deferred-delivery buffer and the tool retracts
      // only the ids returned here. Pre-marking candidates consumed would lose
      // a result that settles between snapshot capture and waiter cleanup,
      // especially on timeout or interruption. Retention interest is separate.
      addRetentionInterest(unique);
      const captureSettled = (settledIds: ReadonlyArray<string>) =>
        settledIds.flatMap((id) => {
          const snapshot = entries.get(id)?.snapshot;
          return snapshot
            ? [structuredClone(snapshot) as SubagentSnapshot]
            : [];
        });
      const loop = Effect.gen(function* () {
        while (true) {
          const observedVersion = changeVersion;
          const settledIds = unique.filter((id) => {
            const entry = entries.get(id);
            return (
              entry !== undefined &&
              entry.snapshot.status !== "running" &&
              entry.resuming !== true
            );
          });
          const pendingIds = unique.filter((id) => {
            const entry = entries.get(id);
            return (
              entry?.snapshot.status === "running" || entry?.resuming === true
            );
          });
          const satisfied =
            mode === "any" ? settledIds.length > 0 : pendingIds.length === 0;
          if (satisfied) {
            return {
              settledIds,
              settledSnapshots: captureSettled(settledIds),
              pendingIds,
              timedOut: false,
            };
          }
          const remaining =
            deadline === undefined ? undefined : deadline - Date.now();
          if (remaining !== undefined && remaining <= 0) {
            return {
              settledIds,
              settledSnapshots: captureSettled(settledIds),
              pendingIds,
              timedOut: true,
            };
          }
          onPending?.(pendingIds);
          yield* remaining === undefined
            ? nextChange(observedVersion)
            : nextChangeWithin(observedVersion, remaining);
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseRetentionInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.resuming && entry.snapshot.status !== "running") {
        // Keep the claim until the in-flight resume effect closes its local
        // scope. A second resume must not steal the shared boolean and let the
        // cancelled attempt attach.
        entry.cancelRequested = true;
        notify(entry.snapshot.id);
        return;
      }
      if (entry.snapshot.status !== "running") return;
      entry.cancelRequested = true;
      if (!entry.session) {
        settle(entry, {
          _tag: "Interrupted",
          partialText: latestText(entry.snapshot) || undefined,
        });
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
        return;
      }
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText =
            "Cancellation deadline exceeded; session was force-disposed";
          persistNow(entry);
          notify(entry.snapshot.id);
        });
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry =>
            entry !== undefined &&
            (entry.snapshot.status === "running" || entry.resuming === true),
        );
      const runningIds = running.map((entry) => entry.snapshot.id);
      addInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (true) {
          const observedVersion = changeVersion;
          if (
            !running.some(
              (entry) =>
                entry.snapshot.status === "running" ||
                (entry.resuming === true && !entry.cancelRequested),
            )
          ) {
            break;
          }
          yield* nextChange(observedVersion);
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "failed",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<SendReceipt, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (!entry.session) {
        return Effect.succeed({
          id,
          disposition: "unsupported",
          receiptAt: Date.now(),
          message:
            "Recovered runs must be resumed before they can receive messages.",
        });
      }
      if (entry.snapshot.status !== "running") {
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        entry.restarting = true;
        entry.cancelRequested = false;
      }
      return entry.session.send(text).pipe(
        Effect.map((disposition) => ({
          id,
          disposition,
          receiptAt: Date.now(),
          message:
            disposition === "queued"
              ? "Message queued for the next turn."
              : "Message delivered to the subagent session.",
        })),
        Effect.onError(() =>
          Effect.sync(() => {
            entry.restarting = false;
          }),
        ),
      );
    });

  const readiness = Effect.forEach(
    [...registry.values()],
    (backend) => backend.readiness,
    { concurrency: "unbounded" },
  );

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    for (const entry of all) {
      if (entry.snapshot.status !== "running") continue;
      settle(entry, {
        _tag: "Interrupted",
        partialText: latestText(entry.snapshot) || undefined,
      });
      entry.snapshot.errorText =
        "Parent session ended while the run was active";
      persistNow(entry);
    }
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    for (const entry of all) persistNow(entry);
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    entries.clear();
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (entry) runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    restore,
    resume,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() =>
      [...entries.values()].map((entry) => entry.snapshot),
    ),
    readiness,
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
