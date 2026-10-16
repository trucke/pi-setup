import type { RouteInfo } from "./catalog.ts";
import type { ConfigLoad, ProxyConfig } from "./config.ts";
import type { CatalogStatus } from "./provider.ts";
import type { TransportSessionStatus } from "./responses.ts";

export interface StatusInput {
  readonly load: ConfigLoad;
  readonly setupError?: string;
  readonly auth?: string;
  readonly catalog?: CatalogStatus;
  readonly sessions?: readonly TransportSessionStatus[];
  readonly currentSessionId?: string;
  readonly now?: number;
}

function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function routeLines(
  model: {
    contextWindow: number;
    maxTokens: number;
    input: readonly string[];
    reasoning: boolean;
  },
  route: RouteInfo,
): string[] {
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

function endpointLines(config: ProxyConfig): string[] {
  return [
    `  endpoint: ${config.root}`,
    `  GPT: ${config.root}/v1/responses (${config.websocket ? "WebSocket with SSE fallback" : "SSE"}); Claude: ${config.root}/v1/messages`,
  ];
}

export function formatStatus(input: StatusInput): string {
  const now = input.now ?? Date.now();
  const { load } = input;
  if (load.status === "absent") {
    return [
      "CLIProxyAPI provider: not configured.",
      `Create ${load.path} with at least {"baseUrl": "http://127.0.0.1:8317"} and run /reload.`,
    ].join("\n");
  }
  if (load.status === "invalid") {
    return [
      `CLIProxyAPI provider: invalid config ${load.path}`,
      ...load.error.split("\n").map((line) => `  ${line}`),
    ]
      .map(printable)
      .join("\n");
  }
  const { config } = load;
  const lines = [
    `CLIProxyAPI provider "${config.provider}" (${config.name})`,
    `  config: ${config.path}`,
  ];
  lines.push(...endpointLines(config));
  if (input.setupError) {
    lines.push(`  not registered: ${input.setupError}`);
    return lines.map(printable).join("\n");
  }
  lines.push(`  auth: ${input.auth ?? "unknown"}`);

  const catalog = input.catalog;
  if (catalog) {
    const checked =
      catalog.checkedAt === undefined
        ? "never checked"
        : `checked ${age(catalog.checkedAt, now)}`;
    const details =
      catalog.richCatalog === undefined
        ? ""
        : catalog.richCatalog
          ? "; CPA model details advertised"
          : "; CPA model details not advertised";
    lines.push(
      `  catalog: ${catalog.source}, ${checked}, scope ${catalog.scope}${details}`,
    );
    if (catalog.lastError) {
      lines.push(
        `  last refresh failed ${age(catalog.lastError.at, now)}: ${catalog.lastError.message}`,
      );
    }
    for (const note of catalog.notes) lines.push(`  note: ${note}`);

    const models = new Map(
      catalog.catalog.models.map((model) => [model.id, model]),
    );
    lines.push(`Models (${catalog.catalog.routes.length}):`);
    for (const route of catalog.catalog.routes) {
      const model = models.get(route.id);
      if (model) lines.push(...routeLines(model, route));
    }
    if (catalog.catalog.warnings.length > 0) {
      lines.push("Catalog warnings:");
      for (const warning of catalog.catalog.warnings)
        lines.push(`  ! ${warning}`);
    }
    if (catalog.catalog.hidden.length > 0) {
      lines.push(`Hidden CPA models (${catalog.catalog.hidden.length}):`);
      for (const hidden of catalog.catalog.hidden)
        lines.push(`  ${hidden.id}: ${hidden.reason}`);
    }
  }

  const sessions = input.sessions ?? [];
  if (config.websocket) {
    lines.push(`WebSocket sessions (${sessions.length}):`);
    for (const session of sessions) {
      const current =
        session.sessionId === input.currentSessionId ? " (this session)" : "";
      const { stats } = session;
      const paused =
        session.websocketPausedUntil === undefined
          ? ""
          : `, WebSocket paused until ${new Date(session.websocketPausedUntil).toLocaleTimeString()}`;
      lines.push(
        `  ${session.sessionId.slice(0, 8)}${current} ${session.modelId}: ${session.connected ? "connected" : "closed"}, continuation ${session.continuation ? "ready" : "none"}${paused}`,
        `    ${stats.requests} WebSocket requests (${stats.deltaRequests} delta, ${stats.fullRequests} full, ${stats.connectionsOpened} connections), ${stats.sseRequests} via SSE`,
      );
      if (stats.lastFallback)
        lines.push(`    last fallback: ${stats.lastFallback}`);
      if (stats.lastError) lines.push(`    last error: ${stats.lastError}`);
    }
  }
  lines.push(
    "Prices are Pi catalog estimates, not CPA billing. WebSocket continuation covers Pi to CPA only; CPA decides how it reaches upstream.",
  );
  return lines.map(printable).join("\n");
}
