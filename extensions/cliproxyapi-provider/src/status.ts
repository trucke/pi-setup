import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
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
    readonly checking?: boolean;
    readonly checkError?: string;
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
  lines.map((line) => printable(clip(line.trimStart(), LINE_LIMIT))).join("\n");

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
  const health = !auth.configured
    ? "not ready"
    : registered.checking
      ? "checking"
      : models === 0
        ? "not ready"
        : status.lastError || registered.checkError
          ? "refresh failed"
          : status.scope === "unverified"
            ? "cached"
            : "ready";

  const lines = [
    `${config.name}: ${health} (status snapshot)`,
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
    lines.push(`  Models: ${models}, ${freshness(status, now)}`);
  }
  if (status.lastError) {
    const previous =
      status.source === "none" ? "" : ", using the previous catalog";
    lines.push(
      `  Last refresh failed ${duration(now - status.lastError.at)} ago${previous}: ${clip(status.lastError.message)}`,
    );
  }

  if (registered.checkError && !status.lastError)
    lines.push(
      `Check failed: ${clip(registered.checkError)}; keeping cached models.`,
    );

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

const MODEL_COLUMNS = [
  "Model",
  "API",
  "Context",
  "Output",
  "Input",
  "Think",
  "Notes",
] as const;
type ModelColumn = (typeof MODEL_COLUMNS)[number];
type ModelRow = Record<ModelColumn, string>;
const tokenNumber = new Intl.NumberFormat("en-US");

/** Keep one row per model; drop optional columns before shortening model ids. */
function modelTable(
  rows: readonly ModelRow[],
  availableWidth: number,
): string[] {
  const width = Math.max(8, Math.floor(availableWidth));
  const columns: readonly ModelColumn[] =
    width >= 100
      ? MODEL_COLUMNS
      : width >= 76
        ? ["Model", "Context", "Output", "Input", "Think", "Notes"]
        : width >= 52
          ? ["Model", "Context", "Output", "Notes"]
          : width >= 32
            ? ["Model", "Context", "Notes"]
            : width >= 20
              ? ["Model", "Notes"]
              : ["Model"];
  const widths = columns.map((column) =>
    Math.max(
      visibleWidth(column),
      ...rows.map((row) => visibleWidth(row[column])),
    ),
  );
  const occupied =
    widths.reduce((sum, value) => sum + value, 0) + 3 * columns.length + 1;
  widths[0] = Math.max(1, (widths[0] ?? 1) - Math.max(0, occupied - width));
  const border = (left: string, join: string, right: string) =>
    left + widths.map((value) => "─".repeat(value + 2)).join(join) + right;
  const line = (values: readonly string[]) =>
    "│" +
    values
      .map((value, index) => {
        const cellWidth = widths[index] ?? 1;
        // Truncation adds ANSI resets; keep cells plain before the report sanitizer runs.
        const cell = stripTerminalSequences(
          truncateToWidth(value, cellWidth, "…"),
        );
        const padding = " ".repeat(Math.max(0, cellWidth - visibleWidth(cell)));
        const numeric =
          columns[index] === "Context" || columns[index] === "Output";
        return ` ${numeric ? padding + cell : cell + padding} `;
      })
      .join("│") +
    "│";
  return [
    border("┌", "┬", "┐"),
    line(columns),
    border("├", "┼", "┤"),
    ...rows.map((row) => line(columns.map((column) => row[column]))),
    border("└", "┴", "┘"),
  ];
}

/** One table row per model, with shared warning text collected below the table. */
export function formatModels(
  config: ProxyConfig,
  status: CatalogStatus,
  now = Date.now(),
  width = 120,
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
  const notes = new Map<string, number>();
  const cell = (value: string) =>
    printable(value).replace(/[│┌┐└┘├┤┬┴┼]/gu, "?");
  const rows: ModelRow[] = [];
  for (const route of [...catalog.routes].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  )) {
    const model = models.get(route.id);
    if (!model) continue;
    const references = route.warnings.map((warning) => {
      const text = printable(warning);
      let number = notes.get(text);
      if (number === undefined) {
        number = notes.size + 1;
        notes.set(text, number);
      }
      return number;
    });
    rows.push({
      Model: cell(route.id),
      API: route.api === "openai-responses" ? "Responses" : "Messages",
      Context: tokenNumber.format(model.contextWindow),
      Output: tokenNumber.format(model.maxTokens),
      Input: model.input.join("+"),
      Think: model.reasoning ? "yes" : "no",
      Notes: references.join(", ") || "-",
    });
  }
  if (rows.length > 0) lines.push(...modelTable(rows, width));
  if (notes.size > 0) {
    lines.push("Notes:");
    for (const [message, number] of notes)
      lines.push(`  [${number}] ${message}`);
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
      "Context and output are token limits. Narrow terminals omit optional columns and shorten long model ids.",
      "Prices are Pi catalog estimates, not CPA billing.",
    );
  }
  return lines.map((line) => printable(line.trimStart())).join("\n");
}
