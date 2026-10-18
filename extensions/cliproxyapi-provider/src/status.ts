import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RouteInfo, RouteModel } from "./catalog.ts";
import type { ConfigLoad, ProxyConfig } from "./config.ts";
import type { CatalogStatus } from "./provider.ts";
import type { TransportSessionStatus } from "./responses.ts";

type AuthStatus = ReturnType<ModelRegistry["getProviderAuthStatus"]>;

export interface StatusInput {
  readonly load: ConfigLoad;
  readonly setupError?: string;
  /** Present once the provider is registered. */
  readonly registered?: {
    readonly auth: AuthStatus;
    readonly catalog: CatalogStatus;
    /** Transport state of every session in this process, including subagents. */
    readonly sessions: readonly TransportSessionStatus[];
    /** The session running the command; status reports only its transport. */
    readonly sessionId: string;
  };
  readonly now?: number;
}

/**
 * Status stays a short summary whatever the proxy or config returns: messages are cut first so
 * the action after them stays visible, and every line is capped as a backstop.
 */
const MESSAGE_LIMIT = 160;
const LINE_LIMIT = 200;
const CONFIG_ERROR_LINES = 4;

const KEY_SOURCES = {
  stored: "stored by /login",
  runtime: "runtime override",
  environment: "environment",
  fallback: "fallback",
  models_json_key: "models.json",
  models_json_command: "models.json command",
} satisfies Record<NonNullable<AuthStatus["source"]>, string>;

/**
 * Model ids, reasons and errors come from the proxy. Replace control characters, including
 * escape sequences and bidirectional overrides, so they cannot restyle or reorder the terminal.
 */
export function printable(line: string): string {
  return line.replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "?",
  );
}

function clip(text: string, limit = MESSAGE_LIMIT): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}

const render = (lines: readonly string[]) =>
  lines.map((line) => printable(clip(line, LINE_LIMIT))).join("\n");

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

function freshness(status: CatalogStatus, now: number): string {
  if (status.source === "none") return "not discovered yet";
  const source = status.source === "live" ? "live" : "cached";
  if (status.scope === "unverified")
    return `${source}, not yet verified for this key`;
  return status.checkedAt === undefined
    ? source
    : `${source}, checked ${duration(now - status.checkedAt)} ago`;
}

function keyText(auth: AuthStatus, config: ProxyConfig): string {
  if (!auth.configured)
    return `missing; set ${config.apiKeyEnv} or run /login ${config.provider}`;
  return auth.label ?? (auth.source ? KEY_SOURCES[auth.source] : "configured");
}

/** One line for the session running the command; other sessions keep their own connections. */
function sessionLines(
  config: ProxyConfig,
  sessions: readonly TransportSessionStatus[],
  sessionId: string,
  now: number,
): string[] {
  if (!config.websocket)
    return ["  GPT: HTTP streaming; WebSocket is off in the config"];
  const label = "  GPT (this session):";
  // Usually one entry; more only if the model or key changed without a session reset.
  const mine = sessions.filter((session) => session.sessionId === sessionId);
  if (mine.length === 0)
    return [`${label} idle; the WebSocket opens on the first GPT request`];

  const sum = (count: (stats: TransportSessionStatus["stats"]) => number) =>
    mine.reduce((total, session) => total + count(session.stats), 0);
  const requests = sum((stats) => stats.requests);
  const viaHttp = sum((stats) => stats.sseRequests);
  const pausedUntil = Math.max(
    0,
    ...mine.map((session) => session.websocketPausedUntil ?? 0),
  );
  const connected = mine
    .filter((session) => session.connected)
    .map((session) => session.modelId);

  const parts = [
    pausedUntil > now
      ? `using HTTP, WebSocket retry in ${duration(pausedUntil - now)}`
      : connected.length > 0
        ? `WebSocket connected for ${connected.length === 1 ? connected[0] : `${connected.length} models`}`
        : "WebSocket closed, reopens on the next GPT request",
  ];
  if (requests > 0) {
    parts.push(
      `${plural(requests, "request")}, ${sum((stats) => stats.deltaRequests)} continued, ${plural(
        sum((stats) => stats.connectionsOpened),
        "connection",
      )}`,
    );
  }
  if (viaHttp > 0) parts.push(`${viaHttp} via HTTP`);
  const lines = [`${label} ${parts.join("; ")}`];

  const error = mine.flatMap(({ stats }) => stats.lastError ?? []).at(-1);
  const fallback = mine.flatMap(({ stats }) => stats.lastFallback ?? []).at(-1);
  if (error) lines.push(`  Last WebSocket error: ${clip(error)}`);
  else if (fallback) lines.push(`  Last fallback: ${clip(fallback)}`);
  return lines;
}

/** Setup guidance while the provider is not registered. */
function setupLines({ load, setupError }: StatusInput): string[] {
  if (load.status === "absent") {
    return [
      "CLIProxyAPI provider: not configured.",
      `Create ${load.path} with at least {"baseUrl": "http://127.0.0.1:8317"} and run /reload.`,
    ];
  }
  if (load.status === "invalid") {
    const errors = load.error.split("\n");
    const more = errors.length - CONFIG_ERROR_LINES;
    return [
      `CLIProxyAPI provider: invalid config ${load.path}`,
      ...errors.slice(0, CONFIG_ERROR_LINES).map((line) => `  ${clip(line)}`),
      ...(more > 0 ? [`  (${plural(more, "more line")})`] : []),
      "  Fix the file and run /reload.",
    ];
  }
  return [
    `${load.config.name}: not registered`,
    `  ${clip(setupError ?? "The provider did not start.")}`,
    `  Config: ${load.config.path}; run /reload after fixing it.`,
  ];
}

/** A short health summary of the provider and this session's GPT transport. */
export function formatStatus(input: StatusInput): string {
  const { load, registered } = input;
  if (load.status !== "ok" || input.setupError || !registered)
    return render(setupLines(input));

  const now = input.now ?? Date.now();
  const { config } = load;
  const { auth, catalog: status, sessions, sessionId } = registered;
  const { catalog } = status;
  const models = catalog.models.length;
  const health =
    !auth.configured || models === 0
      ? "not ready"
      : status.lastError
        ? "refresh failed"
        : status.scope === "unverified"
          ? "unverified"
          : "ready";

  const lines = [
    `${config.name}: ${health}`,
    `  Server: ${config.root} (provider ${config.provider})`,
    `  Key: ${keyText(auth, config)}`,
  ];
  if (status.source === "none") {
    // A failed refresh gets its own line below; notes explain other reasons for no catalog.
    const reason =
      status.lastError || status.notes.length === 0
        ? ""
        : ` (${clip(status.notes.join("; "))})`;
    lines.push(
      `  Models: none yet${reason}${auth.configured ? "; run /proxy refresh" : ""}`,
    );
  } else {
    const verify =
      status.scope === "unverified" ? "; run /proxy refresh to verify" : "";
    lines.push(`  Models: ${models}, ${freshness(status, now)}${verify}`);
  }
  if (status.lastError) {
    const previous =
      status.source === "none" ? "" : ", using the previous catalog";
    lines.push(
      `  Last refresh failed ${duration(now - status.lastError.at)} ago${previous}: ${clip(status.lastError.message)}`,
    );
  }

  // Metadata gaps such as missing prices are expected for aliases and do not affect health.
  const details = [
    [
      catalog.routes.reduce((total, route) => total + route.warnings.length, 0),
      "metadata notice",
    ],
    [catalog.warnings.length, "config warning"],
    [catalog.hidden.length, "hidden id"],
  ] as const;
  const counted = details
    .filter(([count]) => count > 0)
    .map(([count, noun]) => plural(count, noun));
  if (counted.length > 0)
    lines.push(`  Details: ${counted.join(", ")}; see /proxy models`);
  lines.push(...sessionLines(config, sessions, sessionId, now));
  return render(lines);
}

function routeLines(model: RouteModel, route: RouteInfo): string[] {
  const metadata = route.reference
    ? ` metadata ${route.reference}`
    : " no catalog metadata";
  return [
    `  ${route.id} [${route.api}${route.apiSource === "inferred" ? ", inferred" : ""}]${metadata}`,
    `    context ${model.contextWindow} (${route.sources.contextWindow}), max output ${model.maxTokens} (${route.sources.maxTokens}),`,
    `    input ${model.input.join("+")} (${route.sources.input}), reasoning ${model.reasoning ? "yes" : "no"} (${route.sources.reasoning}), price ${route.sources.cost}`,
    ...route.warnings.map((warning) => `    ! ${warning}`),
  ];
}

/** Every routed model with its limits and their sources, warnings and hidden ids. */
export function formatModels(
  config: ProxyConfig,
  status: CatalogStatus,
  now = Date.now(),
): string {
  const { catalog } = status;
  const details =
    status.richCatalog === undefined
      ? ""
      : status.richCatalog
        ? "; CPA model details advertised"
        : "; CPA model details not advertised";
  const lines = [
    `${config.name} models: ${catalog.routes.length} routed, ${catalog.hidden.length} hidden; ${freshness(status, now)}${details}`,
  ];
  if (status.lastError) {
    lines.push(
      `  last refresh failed ${duration(now - status.lastError.at)} ago: ${status.lastError.message}`,
    );
  }
  for (const note of status.notes) lines.push(`  note: ${note}`);
  if (status.source === "none")
    lines.push("  Run /proxy refresh to load them.");

  const models = new Map(catalog.models.map((model) => [model.id, model]));
  if (catalog.routes.length > 0) lines.push("Models:");
  for (const route of catalog.routes) {
    const model = models.get(route.id);
    if (model) lines.push(...routeLines(model, route));
  }
  if (catalog.warnings.length > 0) {
    lines.push("Catalog warnings:");
    for (const warning of catalog.warnings) lines.push(`  ! ${warning}`);
  }
  if (catalog.hidden.length > 0) {
    lines.push(`Hidden CPA models (${catalog.hidden.length}):`);
    for (const hidden of catalog.hidden)
      lines.push(`  ${hidden.id}: ${hidden.reason}`);
  }
  if (catalog.routes.length > 0) {
    lines.push(
      `Sources: route = routes in ${config.path}, cpa = CPA, reference = Pi catalog, default = conservative fallback.`,
      "Prices are Pi catalog estimates, not CPA billing.",
    );
  }
  return lines.map(printable).join("\n");
}
