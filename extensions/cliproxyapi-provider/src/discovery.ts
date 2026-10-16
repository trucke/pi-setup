import type { ModelInputModality } from "@earendil-works/pi-ai";
import { Data, Effect, Option, Schema } from "effect";
import type { CpaModelInfo, DiscoveredModel } from "./catalog.ts";
import { redactSecret } from "./redact.ts";

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly message: string;
}> {}

export interface Discovery {
  readonly models: readonly DiscoveredModel[];
  /** Whether CPA answered `client_version=pi` with its Codex-style catalog. */
  readonly richCatalog: boolean;
  readonly notes: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const ERROR_TEXT_LIMIT = 200;

const BasicList = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const BasicEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  owned_by: Schema.optionalKey(Schema.String),
});
const RichList = Schema.Struct({ models: Schema.Array(Schema.Unknown) });
const RichEntry = Schema.Struct({
  slug: Schema.NonEmptyString,
  display_name: Schema.optionalKey(Schema.String),
  context_window: Schema.optionalKey(Schema.Unknown),
  max_tokens: Schema.optionalKey(Schema.Unknown),
  supported_reasoning_levels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
  input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodeBasicList = Schema.decodeUnknownOption(BasicList);
const decodeBasicEntry = Schema.decodeUnknownOption(BasicEntry);
const decodeRichList = Schema.decodeUnknownOption(RichList);
const decodeRichEntry = Schema.decodeUnknownOption(RichEntry);

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function cpaInfo(entry: typeof RichEntry.Type): CpaModelInfo {
  const input = entry.input_modalities?.filter(
    (modality): modality is ModelInputModality =>
      modality === "text" || modality === "image",
  );
  const contextWindow = positiveInt(entry.context_window);
  const maxTokens = positiveInt(entry.max_tokens);
  return {
    ...(entry.display_name ? { name: entry.display_name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(entry.supported_reasoning_levels
      ? {
          reasoningLevels: entry.supported_reasoning_levels.map(
            (level) => level.effort,
          ),
        }
      : {}),
    ...(input?.length ? { input } : {}),
  };
}

const getJson = (url: string, apiKey: string, timeoutMs: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal,
      });
      if (!response.ok) {
        const text = redactSecret(
          (await response.text().catch(() => "")).trim(),
          apiKey,
        );
        const detail = text ? `: ${text.slice(0, ERROR_TEXT_LIMIT)}` : "";
        throw new Error(`HTTP ${response.status}${detail}`);
      }
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      new DiscoveryError({
        message: redactSecret(
          cause instanceof Error ? cause.message : String(cause),
          apiKey,
        ),
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new DiscoveryError({ message: `timed out after ${timeoutMs}ms` }),
        ),
    }),
  );

/**
 * Read CPA's model list. The plain list decides availability. The Codex-style catalog is optional
 * enrichment: older CPA versions ignore `client_version` and return the plain list again.
 */
export const discover = (
  root: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Effect.Effect<Discovery, DiscoveryError> =>
  Effect.gen(function* () {
    const [basic, rich] = yield* Effect.all(
      [
        getJson(`${root}/v1/models`, apiKey, timeoutMs),
        Effect.option(
          getJson(`${root}/v1/models?client_version=pi`, apiKey, timeoutMs),
        ),
      ],
      { concurrency: 2 },
    );

    const list = decodeBasicList(basic);
    if (Option.isNone(list)) {
      return yield* new DiscoveryError({
        message: "GET /v1/models returned no data array",
      });
    }
    const notes: string[] = [];
    const entries = list.value.data.flatMap((raw) => {
      const entry = decodeBasicEntry(raw);
      return Option.isSome(entry) ? [entry.value] : [];
    });
    const malformed = list.value.data.length - entries.length;
    if (malformed > 0 && entries.length === 0) {
      // A list of only broken entries says nothing about availability; an empty list does.
      return yield* new DiscoveryError({
        message: `GET /v1/models returned ${malformed} entries without a valid id`,
      });
    }
    if (malformed > 0)
      notes.push(`${malformed} malformed /v1/models entries ignored`);

    const richById = new Map<string, CpaModelInfo>();
    const richList = Option.flatMap(rich, decodeRichList);
    if (Option.isSome(richList)) {
      for (const raw of richList.value.models) {
        const entry = decodeRichEntry(raw);
        if (Option.isSome(entry))
          richById.set(entry.value.slug, cpaInfo(entry.value));
      }
    } else {
      notes.push(
        "CPA did not advertise model details (client_version=pi); using Pi's catalog only",
      );
    }

    return {
      richCatalog: Option.isSome(richList),
      notes,
      models: entries.map((entry): DiscoveredModel => {
        const cpa = richById.get(entry.id);
        return {
          id: entry.id,
          ...(entry.owned_by ? { ownedBy: entry.owned_by } : {}),
          ...(cpa ? { cpa } : {}),
        };
      }),
    };
  });
