import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AnthropicMessagesCompat,
  ModelCost,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";

export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const CONFIG_PATH_ENV = "PI_CLIPROXYAPI_CONFIG";
export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_API_KEY_ENV = "CLIPROXYAPI_API_KEY";

export const ROUTE_APIS = ["openai-responses", "anthropic-messages"] as const;
export type RouteApi = (typeof ROUTE_APIS)[number];

export const RESPONSES_COMPAT_FLAGS = [
  "supportsDeveloperRole",
  "supportsMidConvoSystemMessages",
  "supportsLongCacheRetention",
  "supportsStrictMode",
  "supportsOpenAIGrammarTools",
  "supportsAdditionalTools",
  "supportsToolSearch",
  "supportsExplicitPromptCacheMode",
  "supportsMidConvoEffort",
  "supportsMaxOutputTokens",
] as const satisfies readonly (keyof OpenAIResponsesCompat)[];

export const ANTHROPIC_COMPAT_FLAGS = [
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsMidConvoEffort",
  "supportsMidConvoSystemMessages",
  "supportsMidConvoToolChanges",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

type CompatFlag =
  | (typeof RESPONSES_COMPAT_FLAGS)[number]
  | (typeof ANTHROPIC_COMPAT_FLAGS)[number];

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const LevelValue = Schema.optionalKey(Schema.NullOr(Schema.String));
const Rates = {
  input: Price,
  output: Price,
  cacheRead: Price,
  cacheWrite: Price,
};

const ThinkingLevelMapSchema = Schema.Struct({
  off: LevelValue,
  minimal: LevelValue,
  low: LevelValue,
  medium: LevelValue,
  high: LevelValue,
  xhigh: LevelValue,
  max: LevelValue,
});

const CostSchema = Schema.Struct({
  ...Rates,
  tiers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...Rates, inputTokensAbove: PositiveInt })),
  ),
});

const compatFlag = Schema.optionalKey(Schema.Boolean);
const compatFields = Object.fromEntries(
  [
    ...new Set<CompatFlag>([
      ...RESPONSES_COMPAT_FLAGS,
      ...ANTHROPIC_COMPAT_FLAGS,
    ]),
  ].map((flag) => [flag, compatFlag]),
) as Record<CompatFlag, typeof compatFlag>;

const RouteSchema = Schema.Struct({
  api: Schema.optionalKey(Schema.Literals(ROUTE_APIS)),
  /** Provider-qualified Pi catalog entry, such as `openai/gpt-6.1-sol`. `null` disables lookup. */
  metadata: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.String),
  contextWindow: Schema.optionalKey(PositiveInt),
  maxTokens: Schema.optionalKey(PositiveInt),
  input: Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"]))),
  reasoning: Schema.optionalKey(Schema.Boolean),
  thinkingLevelMap: Schema.optionalKey(ThinkingLevelMapSchema),
  cost: Schema.optionalKey(CostSchema),
  compat: Schema.optionalKey(Schema.Struct(compatFields)),
});

const ConfigFileSchema = Schema.Struct({
  baseUrl: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  websocket: Schema.optionalKey(Schema.Boolean),
  routes: Schema.optionalKey(Schema.Record(Schema.String, RouteSchema)),
});

export type RouteConfig = typeof RouteSchema.Type;
export type RouteCompat = NonNullable<RouteConfig["compat"]>;

/** Copy config cost into Pi's mutable model shape; the signature keeps both in sync. */
export const toModelCost = (cost: typeof CostSchema.Type): ModelCost => ({
  ...cost,
  tiers: cost.tiers?.map((tier) => ({ ...tier })),
});

export const toThinkingLevelMap = (
  map: typeof ThinkingLevelMapSchema.Type,
): ThinkingLevelMap => ({ ...map });

export interface ProxyConfig {
  readonly path: string;
  readonly provider: string;
  readonly name: string;
  /** CPA root without a trailing slash or `/v1`. */
  readonly root: string;
  readonly apiKeyEnv: string;
  readonly websocket: boolean;
  readonly routes: Readonly<Record<string, RouteConfig>>;
}

export type ConfigLoad =
  | { readonly status: "absent"; readonly path: string }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly error: string;
    }
  | { readonly status: "ok"; readonly config: ProxyConfig };

export function configPath(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[CONFIG_PATH_ENV]?.trim();
  return override
    ? path.resolve(override)
    : path.join(agentDir, CONFIG_FILE_NAME);
}

/** Accept the CPA root or its `/v1` URL and return the root. */
export function normalizeRoot(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("baseUrl must not contain credentials");
  }
  if (url.search || url.hash)
    throw new Error("baseUrl must not contain a query or fragment");
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${pathname}`;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConfigFileSchema),
  {
    onExcessProperty: "error",
  },
);

export const parseConfig = (
  file: string,
  text: string,
): Effect.Effect<ProxyConfig, string> =>
  decodeConfig(text).pipe(
    Effect.mapError((error) => error.message),
    Effect.flatMap((raw) =>
      Effect.try({
        try: (): ProxyConfig => {
          const provider = raw.provider?.trim() || DEFAULT_PROVIDER_ID;
          if (!PROVIDER_ID.test(provider))
            throw new Error(`invalid provider id "${provider}"`);
          const apiKeyEnv = raw.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
          if (!ENV_NAME.test(apiKeyEnv)) {
            throw new Error(
              "apiKeyEnv must be an environment variable name, not a key",
            );
          }
          return {
            path: file,
            provider,
            name: raw.name?.trim() || "CLIProxyAPI",
            root: normalizeRoot(raw.baseUrl),
            apiKeyEnv,
            websocket: raw.websocket ?? true,
            routes: raw.routes ?? {},
          };
        },
        catch: (error) =>
          error instanceof Error ? error.message : String(error),
      }),
    ),
  );

export const loadConfig = (file: string): Effect.Effect<ConfigLoad> =>
  Effect.tryPromise(() => readFile(file, "utf8")).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed<ConfigLoad>(
          isMissingFile(error.cause)
            ? { status: "absent", path: file }
            : {
                status: "invalid",
                path: file,
                error: "cannot read config file",
              },
        ),
      onSuccess: (text) =>
        parseConfig(file, text).pipe(
          Effect.match({
            onFailure: (error): ConfigLoad => ({
              status: "invalid",
              path: file,
              error,
            }),
            onSuccess: (config): ConfigLoad => ({ status: "ok", config }),
          }),
        ),
    }),
  );

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A `models.json` provider that defines its own endpoint or models would be merged over this
 * provider by Pi. Refuse that silently-composed setup; overrides-only blocks are fine.
 */
export async function findModelsJsonConflict(
  agentDir: string,
  providerId: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(agentDir, "models.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
  const entry = parsed.providers[providerId];
  if (!isRecord(entry)) return undefined;
  const keys = ["models", "baseUrl", "api", "oauth"].filter(
    (key) => key in entry,
  );
  return keys.length > 0
    ? `models.json already defines provider "${providerId}" (${keys.join(", ")}). Remove or rename that block, or set "provider" to another id.`
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
