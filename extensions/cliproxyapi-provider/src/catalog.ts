import { createHash, scrypt } from "node:crypto";
import {
  hasApi,
  type AnthropicMessagesCompat,
  type Api,
  type Model,
  type ModelCost,
  type ModelInputModality,
  type ModelThinkingLevel,
  type ModelsStoreEntry,
  type OpenAIResponsesCompat,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";
import {
  ANTHROPIC_COMPAT_FLAGS,
  RESPONSES_COMPAT_FLAGS,
  toModelCost,
  toThinkingLevelMap,
  type ProxyConfig,
  type RouteApi,
  type RouteCompat,
  type RouteConfig,
} from "./config.ts";

/** What CPA reported for one model id. */
export interface DiscoveredModel {
  readonly id: string;
  readonly ownedBy?: string;
  /** Present only when CPA served the Codex-style catalog for this id. */
  readonly cpa?: CpaModelInfo;
}

export interface CpaModelInfo {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** Wire reasoning efforts such as `none`, `low`, `xhigh`. Empty means none advertised. */
  readonly reasoningLevels?: readonly string[];
  readonly input?: readonly ModelInputModality[];
}

export type RouteModel =
  Model<"openai-responses"> | Model<"anthropic-messages">;
export type FieldSource = "route" | "cpa" | "reference" | "default";

export interface RouteInfo {
  readonly id: string;
  readonly api: RouteApi;
  readonly apiSource: "route" | "inferred";
  /** Provider-qualified catalog entry used for enrichment, when one was found. */
  readonly reference?: string;
  readonly ownedBy?: string;
  readonly sources: {
    readonly contextWindow: FieldSource;
    readonly maxTokens: FieldSource;
    readonly input: FieldSource;
    readonly reasoning: FieldSource;
    readonly cost: FieldSource;
  };
  readonly warnings: readonly string[];
}

export interface ResolvedCatalog {
  readonly models: readonly RouteModel[];
  readonly routes: readonly RouteInfo[];
  readonly hidden: readonly { readonly id: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export type ReferenceLookup = (
  provider: string,
  id: string,
) => Model<Api> | undefined;

export const EMPTY_CATALOG: ResolvedCatalog = {
  models: [],
  routes: [],
  hidden: [],
  warnings: [],
};

// Conservative values for routes without verified limits; Pi uses the same for models.json.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const PI_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

/**
 * Compat flags taken from a referenced catalog entry. They describe the model's request shape.
 * Mid-conversation features (configuration_update, in-place system/tool changes), tool search,
 * grammar tools and vendor fallbacks depend on the proxy route, so a route must enable them
 * explicitly.
 */
const INHERITED_RESPONSES_FLAGS = [
  "supportsDeveloperRole",
  "supportsStrictMode",
  "supportsMaxOutputTokens",
] as const satisfies readonly (keyof OpenAIResponsesCompat)[];
const INHERITED_ANTHROPIC_FLAGS = [
  "forceAdaptiveThinking",
  "supportsTemperature",
  "supportsStrictTools",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

const RESPONSES_REFERENCE_APIS: ReadonlySet<Api> = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

function inferApi(id: string): RouteApi | undefined {
  // Prefixed ids (`go/claude-…`, `team/gpt-…`) belong to other routes or providers.
  if (id.includes("/")) return undefined;
  if (id.startsWith("gpt-")) return "openai-responses";
  if (id.startsWith("claude-")) return "anthropic-messages";
  return undefined;
}

function defaultReference(api: RouteApi, id: string): string {
  return `${api === "openai-responses" ? "openai" : "anthropic"}/${id}`;
}

function splitReference(reference: string): [string, string] | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  return [reference.slice(0, slash), reference.slice(slash + 1)];
}

function levelsFromCpa(levels: readonly string[]): ThinkingLevelMap {
  const advertised = new Set(levels.map((level) => level.toLowerCase()));
  const map: ThinkingLevelMap = {};
  for (const level of PI_LEVELS) {
    const wire = level === "off" ? "none" : level;
    map[level] = advertised.has(wire) ? wire : null;
  }
  return map;
}

function pickFlags<C extends object, K extends keyof C>(
  compat: C | undefined,
  flags: readonly K[],
): Partial<Pick<C, K>> {
  const picked: Partial<Pick<C, K>> = {};
  if (!compat) return picked;
  for (const flag of flags) {
    if (compat[flag] !== undefined) picked[flag] = compat[flag];
  }
  return picked;
}

function routeCompatFor<K extends keyof RouteCompat>(
  compat: RouteCompat | undefined,
  allowed: readonly K[],
  warnings: string[],
): Partial<Pick<RouteCompat, K>> {
  if (!compat) return {};
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  const ignored = Object.keys(compat).filter((flag) => !allowedSet.has(flag));
  if (ignored.length > 0)
    warnings.push(`compat ${ignored.join(", ")} ignored for this API`);
  return pickFlags(compat, allowed);
}

function resolveRoute(
  discovered: DiscoveredModel,
  route: RouteConfig | undefined,
  api: RouteApi,
  config: ProxyConfig,
  lookup: ReferenceLookup,
): { model: RouteModel; info: RouteInfo } {
  const warnings: string[] = [];
  const isResponses = api === "openai-responses";
  const cpa = discovered.cpa;

  let reference: Model<Api> | undefined;
  const referenceName =
    route?.metadata === null
      ? undefined
      : (route?.metadata ?? defaultReference(api, discovered.id));
  if (referenceName) {
    const parts = splitReference(referenceName);
    const candidate =
      parts && parts[0] !== config.provider
        ? lookup(parts[0], parts[1])
        : undefined;
    const compatible =
      candidate &&
      (isResponses
        ? RESPONSES_REFERENCE_APIS.has(candidate.api)
        : candidate.api === api);
    if (compatible) reference = candidate;
    else if (candidate)
      warnings.push(`metadata ${referenceName} uses ${candidate.api}; ignored`);
    else if (route?.metadata)
      warnings.push(`metadata ${referenceName} not found in Pi's catalog`);
  }

  // Codex-style CPA metadata is cloned from GPT templates for models CPA lacks data for, so it is
  // only trusted for capabilities on Responses routes. Context size is trusted on both, but on
  // Anthropic routes a matching first-party catalog entry wins.
  const cpaContext = cpa?.contextWindow;
  const cpaMaxTokens = isResponses ? cpa?.maxTokens : undefined;
  const cpaInput = isResponses && cpa?.input?.length ? cpa.input : undefined;
  const cpaLevels = isResponses ? cpa?.reasoningLevels : undefined;

  const pick = <T>(
    candidates: readonly [FieldSource, T | undefined][],
    fallback: T,
  ): [FieldSource, T] => {
    for (const [source, value] of candidates)
      if (value !== undefined) return [source, value];
    return ["default", fallback];
  };

  const referenceContext = reference?.contextWindow;
  let [contextSource, contextWindow] = pick(
    [
      ["route", route?.contextWindow],
      ["cpa", cpaContext],
      ["reference", referenceContext],
    ],
    DEFAULT_CONTEXT_WINDOW,
  );
  if (
    contextSource === "cpa" &&
    reference &&
    referenceContext !== undefined &&
    cpaContext !== undefined &&
    referenceContext !== cpaContext
  ) {
    const conflict = `CPA advertises ${cpaContext} context, ${reference.provider}/${reference.id} lists ${referenceContext}`;
    if (isResponses) {
      warnings.push(`${conflict}; using CPA's route value`);
    } else {
      // CPA can report a GPT template's window for Claude ids, so neither value is proven here.
      if (referenceContext < cpaContext)
        [contextSource, contextWindow] = ["reference", referenceContext];
      warnings.push(
        `${conflict}; using the smaller value, set routes[id].contextWindow to confirm`,
      );
    }
  }
  let [maxTokensSource, maxTokens] = pick(
    [
      ["route", route?.maxTokens],
      ["cpa", cpaMaxTokens],
      ["reference", reference?.maxTokens],
    ],
    DEFAULT_MAX_TOKENS,
  );
  if (maxTokens > contextWindow) {
    warnings.push(
      `max output ${maxTokens} exceeds context ${contextWindow}; clamped`,
    );
    maxTokens = contextWindow;
  }
  const [inputSource, input] = pick<readonly ModelInputModality[]>(
    [
      ["route", route?.input],
      ["cpa", cpaInput],
      ["reference", reference?.input],
    ],
    ["text"],
  );

  let reasoningSource: FieldSource = "default";
  let reasoning = false;
  let thinkingLevelMap: ThinkingLevelMap | undefined;
  if (cpaLevels !== undefined) {
    reasoningSource = "cpa";
    reasoning = cpaLevels.length > 0;
    thinkingLevelMap = reasoning ? levelsFromCpa(cpaLevels) : undefined;
    if (!reasoning && reference?.reasoning) {
      warnings.push(
        "CPA advertises no reasoning levels; reference reasoning ignored",
      );
    }
  } else if (reference) {
    reasoningSource = "reference";
    reasoning = reference.reasoning;
    thinkingLevelMap = reference.thinkingLevelMap
      ? { ...reference.thinkingLevelMap }
      : undefined;
  }
  if (route?.reasoning !== undefined || route?.thinkingLevelMap !== undefined) {
    reasoningSource = "route";
    reasoning = route.reasoning ?? reasoning;
    if (route.thinkingLevelMap) {
      thinkingLevelMap = {
        ...thinkingLevelMap,
        ...toThinkingLevelMap(route.thinkingLevelMap),
      };
    }
  }
  if (!reasoning) thinkingLevelMap = undefined;

  const [costSource, cost] = pick<ModelCost>(
    [
      ["route", route?.cost ? toModelCost(route.cost) : undefined],
      ["reference", reference?.cost],
    ],
    ZERO_COST,
  );
  if (costSource === "default")
    warnings.push("no price data; cost shows 0, which does not mean free");
  if (contextSource === "default")
    warnings.push("context and output limits are unverified defaults");

  const name = route?.name ?? cpa?.name ?? reference?.name ?? discovered.id;
  const inputLimits = input.includes("image")
    ? reference?.inputLimits
    : undefined;
  const common = {
    id: discovered.id,
    name,
    provider: config.provider,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: [...input],
    ...(inputLimits ? { inputLimits } : {}),
    cost: { ...cost, tiers: cost.tiers?.map((tier) => ({ ...tier })) },
    contextWindow,
    maxTokens,
  };

  const model: RouteModel = isResponses
    ? {
        ...common,
        api: "openai-responses",
        baseUrl: `${config.root}/v1`,
        compat: {
          ...pickFlags(
            reference && hasApi(reference, "openai-responses")
              ? reference.compat
              : undefined,
            INHERITED_RESPONSES_FLAGS,
          ),
          ...pickFlags(
            reference && hasApi(reference, "openai-codex-responses")
              ? reference.compat
              : undefined,
            INHERITED_RESPONSES_FLAGS,
          ),
          ...routeCompatFor(route?.compat, RESPONSES_COMPAT_FLAGS, warnings),
        },
      }
    : {
        ...common,
        api: "anthropic-messages",
        // Pi's Anthropic client appends /v1/messages to the CPA root.
        baseUrl: config.root,
        compat: {
          ...pickFlags(
            reference && hasApi(reference, "anthropic-messages")
              ? reference.compat
              : undefined,
            INHERITED_ANTHROPIC_FLAGS,
          ),
          ...routeCompatFor(route?.compat, ANTHROPIC_COMPAT_FLAGS, warnings),
        },
      };

  return {
    model,
    info: {
      id: discovered.id,
      api,
      apiSource: route?.api ? "route" : "inferred",
      ...(reference
        ? { reference: `${reference.provider}/${reference.id}` }
        : {}),
      ...(discovered.ownedBy ? { ownedBy: discovered.ownedBy } : {}),
      sources: {
        contextWindow: contextSource,
        maxTokens: maxTokensSource,
        input: inputSource,
        reasoning: reasoningSource,
        cost: costSource,
      },
      warnings,
    },
  };
}

/** Turn CPA's model list into Pi models. CPA decides availability; Pi's catalog only enriches. */
export function resolveCatalog(
  discovered: readonly DiscoveredModel[],
  config: ProxyConfig,
  lookup: ReferenceLookup,
): ResolvedCatalog {
  const models: RouteModel[] = [];
  const routes: RouteInfo[] = [];
  const hidden: { id: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const entry of discovered) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const route = config.routes[entry.id];
    const api = route?.api ?? inferApi(entry.id);
    if (!api) {
      hidden.push({
        id: entry.id,
        reason: route
          ? "route has no api and none can be inferred"
          : "not a bare gpt-* or claude-* id; add routes[id].api to use it",
      });
      continue;
    }
    const resolved = resolveRoute(entry, route, api, config, lookup);
    models.push(resolved.model);
    routes.push(resolved.info);
  }

  const warnings = Object.keys(config.routes)
    .filter((id) => !seen.has(id))
    .map((id) => `route ${id} is configured but CPA does not offer it`);
  return { models, routes, hidden, warnings };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CpaInfoSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Int),
  maxTokens: Schema.optionalKey(Schema.Int),
  reasoningLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  input: Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"]))),
});

const PersistedModelSchema = Schema.Struct({
  id: Schema.String,
  cliproxyapi: Schema.Struct({
    v: Schema.Literal(1),
    /** CPA root the catalog came from. Not secret, so it is checkable offline. */
    endpoint: Schema.String,
    /** `scopeId()` of the endpoint and key used for discovery. */
    credential: Schema.String,
    ownedBy: Schema.optionalKey(Schema.String),
    cpa: Schema.optionalKey(CpaInfoSchema),
  }),
});

const decodePersisted = Schema.decodeUnknownOption(
  Schema.Array(PersistedModelSchema),
);

export interface CatalogScope {
  readonly endpoint: string;
  readonly credential: string;
}

export interface StoredCatalog extends CatalogScope {
  readonly discovered: readonly DiscoveredModel[];
  readonly checkedAt?: number;
}

/**
 * Persist resolved models for offline startup. Each entry also carries the CPA facts it came from
 * and the endpoint/credential scope, so restores re-run enrichment with the current config.
 */
export function toStoreEntry(
  catalog: ResolvedCatalog,
  discovered: readonly DiscoveredModel[],
  scope: CatalogScope,
  checkedAt: number,
): ModelsStoreEntry {
  const facts = new Map(discovered.map((entry) => [entry.id, entry]));
  return {
    checkedAt,
    models: catalog.models.map((model) => {
      const fact = facts.get(model.id);
      return {
        ...model,
        cliproxyapi: {
          v: 1,
          endpoint: scope.endpoint,
          credential: scope.credential,
          ...(fact?.ownedBy ? { ownedBy: fact.ownedBy } : {}),
          ...(fact?.cpa ? { cpa: fact.cpa } : {}),
        },
      };
    }),
  };
}

export function fromStoreEntry(
  entry: { readonly models: unknown; readonly checkedAt?: number } | undefined,
): StoredCatalog | undefined {
  if (!entry) return undefined;
  const decoded = decodePersisted(entry.models);
  if (decoded._tag === "None") return undefined;
  const [first] = decoded.value;
  if (!first) return undefined;
  const { endpoint, credential } = first.cliproxyapi;
  const consistent = decoded.value.every(
    (model) =>
      model.cliproxyapi.endpoint === endpoint &&
      model.cliproxyapi.credential === credential,
  );
  if (!consistent) return undefined;
  return {
    endpoint,
    credential,
    ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
    discovered: decoded.value.map((model) => ({
      id: model.id,
      ...(model.cliproxyapi.ownedBy
        ? { ownedBy: model.cliproxyapi.ownedBy }
        : {}),
      ...(model.cliproxyapi.cpa ? { cpa: model.cliproxyapi.cpa } : {}),
    })),
  };
}

const scopeCache = new Map<string, Promise<string>>();

/**
 * Non-reversible id for an endpoint and key pair. scrypt with the endpoint as salt keeps weak
 * client keys from being confirmed cheaply from a copied models-store.json.
 */
export function scopeId(root: string, apiKey: string): Promise<string> {
  const cacheKey = createHash("sha256")
    .update(`${root}\0${apiKey}`)
    .digest("hex");
  let pending = scopeCache.get(cacheKey);
  if (!pending) {
    pending = new Promise<string>((resolve, reject) => {
      scrypt(
        apiKey,
        `pi-cliproxyapi-scope-v1\0${root}`,
        16,
        (error, derived) =>
          error ? reject(error) : resolve(derived.toString("hex")),
      );
    });
    scopeCache.set(cacheKey, pending);
  }
  return pending;
}
