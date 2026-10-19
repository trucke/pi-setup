import { readFile } from "node:fs/promises";
import {
  createAssistantMessageEventStream,
  hasApi,
  type ApiKeyAuth,
  type AssistantMessageEventStream,
  type Credential,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { Cause, Effect, Exit } from "effect";
import {
  EMPTY_CATALOG,
  fromStoreEntry,
  resolveCatalog,
  scopeId,
  toStoreEntry,
  type DiscoveredModel,
  type ReferenceLookup,
  type ResolvedCatalog,
  type StoredCatalog,
} from "./catalog.ts";
import type { ProxyConfig, RouteApi } from "./config.ts";
import { discover, type Discovery, type DiscoveryError } from "./discovery.ts";
import {
  createResponsesTransport,
  type ResponsesTransport,
} from "./responses.ts";

/** Reuse a matching catalog, including persisted results, until this age; `/proxy refresh` bypasses it. */
const FRESH_FOR_MS = 5 * 60_000;
/** Upper bound for the one-time discovery when Pi starts without a usable cached catalog. */
const BOOTSTRAP_TIMEOUT_MS = 8_000;

export interface CatalogStatus {
  readonly source: "none" | "cache" | "live";
  readonly checkedAt?: number;
  /** Whether the shown catalog was confirmed for the current endpoint and key. */
  readonly scope: "verified" | "unverified";
  readonly richCatalog?: boolean;
  readonly notes: readonly string[];
  readonly lastError?: { readonly message: string; readonly at: number };
  readonly catalog: ResolvedCatalog;
}

export interface ProxyProvider {
  readonly provider: Provider<RouteApi>;
  readonly transport: ResponsesTransport;
  readonly status: () => CatalogStatus;
  /** Prefer the session's live Pi catalog (with pi.dev updates) over the bundled one. */
  readonly setReferenceLookup: (lookup: ReferenceLookup) => void;
  /**
   * Load the cached catalog from Pi's store file, or on first use discover once, bounded, unless
   * offline or without an environment key. Must run before registration: Pi starts two
   * overlapping cache-only refreshes and may select a model before the surviving one publishes,
   * so the catalog has to be in memory already. Restores then only re-verify it.
   */
  readonly initialize: (storeFile: string) => Promise<void>;
}

const builtinProviders: ReadonlySet<string> = new Set(getBuiltinProviders());
const isBuiltinProvider = (id: string): id is BuiltinProvider =>
  builtinProviders.has(id);

export const bundledReference: ReferenceLookup = (provider, id) =>
  isBuiltinProvider(provider)
    ? getBuiltinModels(provider).find((model) => model.id === id)
    : undefined;

export function isBuiltinProviderId(id: string): boolean {
  return isBuiltinProvider(id);
}

function apiKeyAuth(config: ProxyConfig): ApiKeyAuth {
  return {
    name: `${config.name} client key`,
    login: async (interaction) => ({
      type: "api_key",
      key: await interaction.prompt({
        type: "secret",
        message: `Enter the ${config.name} client key`,
      }),
    }),
    check: async ({ ctx, credential }) => {
      if (credential?.key)
        return { type: "api_key", source: "stored credential" };
      return (await ctx.env(config.apiKeyEnv))
        ? { type: "api_key", source: config.apiKeyEnv }
        : undefined;
    },
    resolve: async ({ ctx, credential }) => {
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          source: "stored credential",
        };
      }
      const key = await ctx.env(config.apiKeyEnv);
      return key
        ? { auth: { apiKey: key }, source: config.apiKeyEnv }
        : undefined;
    },
  };
}

/**
 * The key a cache restore can check without side effects. Stored `!command` keys are resolved by
 * Pi only when needed. Read-only contexts can retain the command rather than its resolved key.
 */
function offlineKey(
  config: ProxyConfig,
  credential: Credential | undefined,
): string | undefined {
  if (credential?.type === "api_key") {
    return credential.key && !credential.key.startsWith("!")
      ? credential.key
      : undefined;
  }
  return process.env[config.apiKeyEnv] || undefined;
}

/** Pi's file-backed catalog entry for one provider, read without locking or modifying it. */
async function readStoreEntry(
  storeFile: string,
  providerId: string,
): Promise<
  { readonly models: unknown; readonly checkedAt?: number } | undefined
> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storeFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry: unknown = Reflect.get(parsed, providerId);
    if (typeof entry !== "object" || entry === null || !("models" in entry)) {
      return undefined;
    }
    const checkedAt = "checkedAt" in entry ? entry.checkedAt : undefined;
    return {
      models: entry.models,
      ...(typeof checkedAt === "number" ? { checkedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function errorStream(
  model: Model<RouteApi>,
  message: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  });
  stream.end();
  return stream;
}

function failureMessage(exit: Exit.Failure<Discovery, DiscoveryError>): string {
  const failure = Cause.squash(exit.cause);
  return failure instanceof Error ? failure.message : String(failure);
}

interface State {
  source: CatalogStatus["source"];
  scope: CatalogStatus["scope"];
  /** `scopeId()` of the endpoint and key the shown catalog was discovered with. */
  credential?: string;
  discovered: readonly DiscoveredModel[];
  catalog: ResolvedCatalog;
  checkedAt?: number;
  richCatalog?: boolean;
  notes: readonly string[];
  lastError?: { message: string; at: number };
  /** False for a bootstrap result that Pi has not stored yet. */
  persisted: boolean;
}

const emptyState = (notes: readonly string[]): State => ({
  source: "none",
  scope: "unverified",
  discovered: [],
  catalog: EMPTY_CATALOG,
  notes,
  persisted: true,
});

export function createProxyProvider(config: ProxyConfig): ProxyProvider {
  const anthropic = anthropicMessagesApi();
  const transport = createResponsesTransport({
    root: config.root,
    websocket: config.websocket,
  });
  let lookup: ReferenceLookup = bundledReference;
  let state = emptyState([]);

  const liveState = (
    discovery: Discovery,
    credential: string,
    persisted: boolean,
  ): State => ({
    source: "live",
    scope: "verified",
    credential,
    discovered: discovery.models,
    catalog: resolveCatalog(discovery.models, config, lookup),
    checkedAt: Date.now(),
    richCatalog: discovery.richCatalog,
    notes: discovery.notes,
    persisted,
  });

  const cacheState = (stored: StoredCatalog, verified: boolean): State => ({
    source: "cache",
    scope: verified ? "verified" : "unverified",
    credential: stored.credential,
    discovered: stored.discovered,
    catalog: resolveCatalog(stored.discovered, config, lookup),
    ...(stored.checkedAt === undefined ? {} : { checkedAt: stored.checkedAt }),
    notes: verified
      ? []
      : [
          "Using a cached model list; the current key has not been checked yet.",
        ],
    persisted: true,
  });

  const storeEntry = (next: State) =>
    toStoreEntry(
      next.catalog,
      next.discovered,
      { endpoint: config.root, credential: next.credential ?? "" },
      next.checkedAt ?? Date.now(),
    );

  const restore = async (context: RefreshModelsContext) => {
    const stored = fromStoreEntry(context.stored);
    const key = offlineKey(config, context.credential);
    const credential = key ? await scopeId(config.root, key) : undefined;

    // The catalog loaded at startup or fetched since is at least as new as the store: re-run
    // enrichment, and store a first-use result that Pi has not persisted yet.
    if (
      state.source !== "none" &&
      (credential === undefined || credential === state.credential)
    ) {
      const verified = credential !== undefined;
      const next = {
        ...state,
        scope: verified ? ("verified" as const) : state.scope,
        notes: verified && state.scope === "unverified" ? [] : state.notes,
        catalog: resolveCatalog(state.discovered, config, lookup),
        persisted: true,
      };
      await context.publish({
        ...(state.persisted ? {} : { persist: storeEntry(next) }),
        update: () => (state = next),
      });
      return;
    }
    let next: State;
    if (!stored) {
      next = emptyState(
        context.stored === undefined
          ? []
          : ["cached catalog is unreadable or empty; ignored"],
      );
    } else if (stored.endpoint !== config.root) {
      next = emptyState([
        "cached catalog is for another endpoint; ignored until refresh",
      ]);
    } else if (credential !== undefined && credential !== stored.credential) {
      next = emptyState([
        "cached catalog is for another key; ignored until refresh",
      ]);
    } else {
      next = cacheState(stored, credential !== undefined);
    }
    // Keep a bootstrap failure visible until something replaces it.
    if (state.lastError && next.source === "none") {
      next = { ...next, notes: state.notes, lastError: state.lastError };
    }
    await context.publish({ update: () => (state = next) });
  };

  const fetchLive = async (context: RefreshModelsContext) => {
    const key =
      context.credential?.type === "api_key"
        ? context.credential.key
        : undefined;
    if (!key)
      throw new Error(
        `No ${config.name} key; set ${config.apiKeyEnv} or run /login ${config.provider}`,
      );
    const credential = await scopeId(config.root, key);
    const age =
      state.checkedAt === undefined ? undefined : Date.now() - state.checkedAt;
    const fresh =
      state.source !== "none" &&
      state.credential === credential &&
      age !== undefined &&
      age >= 0 &&
      age < FRESH_FOR_MS;
    if (fresh && !context.force) {
      // A live refresh can resolve a stored command key that the cache-only phase could not.
      if (state.scope !== "verified" || !state.persisted)
        await restore(context);
      return;
    }

    const exit = await Effect.runPromiseExit(discover(config.root, key), {
      signal: context.signal,
    });
    if (Exit.isFailure(exit)) {
      if (context.signal.aborted) return;
      const message = failureMessage(exit);
      state = { ...state, lastError: { message, at: Date.now() } };
      throw new Error(`${config.name} discovery failed: ${message}`);
    }
    const next = liveState(exit.value, credential, true);
    await context.publish({
      persist: storeEntry(next),
      update: () => (state = next),
    });
  };

  const initialize = async (storeFile: string) => {
    const cached = fromStoreEntry(
      await readStoreEntry(storeFile, config.provider),
    );
    const key = process.env[config.apiKeyEnv] || undefined;
    const credential = key ? await scopeId(config.root, key) : undefined;
    if (
      cached?.endpoint === config.root &&
      (credential === undefined || cached.credential === credential)
    ) {
      state = cacheState(cached, credential !== undefined);
      return;
    }
    if (!key || !credential || process.env.PI_OFFLINE !== undefined) return;
    const exit = await Effect.runPromiseExit(
      discover(config.root, key, BOOTSTRAP_TIMEOUT_MS),
    );
    if (Exit.isFailure(exit)) {
      const message = failureMessage(exit);
      state = {
        ...emptyState([`first-use discovery failed: ${message}`]),
        lastError: { message, at: Date.now() },
      };
      return;
    }
    state = liveState(exit.value, credential, false);
  };

  const dispatch = (
    model: Model<RouteApi>,
    context: TranscriptContext,
    options: StreamOptions | undefined,
    simple: boolean,
  ): AssistantMessageEventStream => {
    if (hasApi(model, "anthropic-messages")) {
      return simple
        ? anthropic.streamSimple(model, context, options)
        : anthropic.stream(model, context, options);
    }
    if (hasApi(model, "openai-responses")) {
      return simple
        ? transport.streamSimple(model, context, options)
        : transport.stream(model, context, options);
    }
    return errorStream(
      model,
      `${config.name} has no implementation for ${model.api}`,
    );
  };

  const provider: Provider<RouteApi> = {
    id: config.provider,
    name: config.name,
    baseUrl: config.root,
    auth: { apiKey: apiKeyAuth(config) },
    getModels: () => state.catalog.models,
    refreshModels: (context) =>
      context.allowNetwork ? fetchLive(context) : restore(context),
    stream: (model, context, options) =>
      dispatch(model, context, options, false),
    streamSimple: (model, context, options) =>
      dispatch(model, context, options, true),
  };

  return {
    provider,
    transport,
    initialize,
    setReferenceLookup: (next) => {
      lookup = next;
    },
    status: () => ({
      source: state.source,
      scope: state.scope,
      catalog: state.catalog,
      notes: state.notes,
      ...(state.checkedAt === undefined ? {} : { checkedAt: state.checkedAt }),
      ...(state.richCatalog === undefined
        ? {}
        : { richCatalog: state.richCatalog }),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    }),
  };
}
