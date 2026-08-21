import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type {
  BackendName,
  SendError,
  SendReceipt,
  SpawnError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

export interface BackendCapabilities {
  readonly steering: boolean;
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
  readonly nativeResume: boolean;
  readonly review: boolean;
}

export interface BackendReadiness {
  readonly backend: BackendName;
  readonly ready: boolean;
  readonly detail: string;
}

export interface SubagentSession {
  readonly meta: Effect.Effect<SubagentMeta>;
  readonly events: Stream.Stream<SubagentEvent>;
  send(text: string): Effect.Effect<SendReceipt["disposition"], SendError>;
  readonly interrupt: Effect.Effect<void>;
}

export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  readonly readiness: Effect.Effect<BackendReadiness>;
  spawn(
    task: SpawnTask,
  ): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

export class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}
