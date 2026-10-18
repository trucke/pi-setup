import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveCatalog, type DiscoveredModel } from "./src/catalog.ts";
import type { ProxyConfig } from "./src/config.ts";
import { bundledReference, type CatalogStatus } from "./src/provider.ts";
import type { TransportSessionStatus } from "./src/responses.ts";
import { formatModels, formatStatus, type StatusInput } from "./src/status.ts";

const config: ProxyConfig = {
  path: "/agent/cliproxyapi.json",
  provider: "proxy",
  name: "CLIProxyAPI",
  root: "http://cpa.test",
  apiKeyEnv: "CLIPROXYAPI_API_KEY",
  websocket: true,
  routes: { "gpt-retired": { api: "openai-responses" } },
};

// 34 routed models, most of them aliases without catalog metadata, and 2 hidden ids.
const discovered: DiscoveredModel[] = [
  { id: "gpt-6.1-sol", cpa: { contextWindow: 500_000 } },
  { id: "claude-opus-5-5" },
  ...Array.from({ length: 32 }, (_, index) => ({ id: `gpt-legacy-${index}` })),
  { id: "go/claude-haiku-5-5" },
  { id: "evil\u001b[2Jid\u202e" },
];
const live: CatalogStatus = {
  source: "live",
  scope: "verified",
  checkedAt: 0,
  notes: [],
  catalog: resolveCatalog(discovered, config, bundledReference),
};

const status = (
  registered: Partial<NonNullable<StatusInput["registered"]>> = {},
  proxyConfig = config,
) =>
  formatStatus({
    load: { status: "ok", config: proxyConfig },
    registered: {
      auth: {
        configured: true,
        source: "environment",
        label: "CLIPROXYAPI_API_KEY",
      },
      catalog: live,
      sessions: [],
      sessionId: "current",
      ...registered,
    },
    now: 60_000,
  });

const session = (
  sessionId: string,
  state: Partial<TransportSessionStatus>,
  stats: Partial<TransportSessionStatus["stats"]> = {},
): TransportSessionStatus => ({
  sessionId,
  modelId: "gpt-6.1-sol",
  connected: false,
  continuation: false,
  ...state,
  stats: {
    requests: 0,
    fullRequests: 0,
    deltaRequests: 0,
    connectionsOpened: 0,
    sseRequests: 0,
    ...stats,
  },
});

test("status is a short summary of any catalog size; /proxy models has the details", () => {
  assert.equal(
    status(),
    [
      "CLIProxyAPI: ready (status snapshot)",
      "Server: http://cpa.test (provider proxy)",
      "Key: CLIPROXYAPI_API_KEY",
      "Models: 34, live, checked 60s ago",
      "Details: 65 metadata notices, 1 config warning, 2 hidden ids; see /proxy models",
      "GPT (this session): idle; the WebSocket opens on the first GPT request",
    ].join("\n"),
  );

  const models = formatModels(config, live, 60_000);
  for (const { id } of live.catalog.routes) assert.ok(models.includes(id), id);
  assert.match(models, /500,000/);
  assert.match(models, /│ gpt-legacy-0\s+│ Responses/);
  assert.match(models, /no price data; cost shows 0/);
  assert.match(
    models,
    /! route gpt-retired is configured but CPA does not offer it/,
  );
  assert.match(models, /go\/claude-haiku-5-5: not a bare/);
  assert.match(models, /evil\?\[2Jid\?: not a bare/);
  assert.match(models, /not CPA billing/);
});

test("models are aligned table rows that fit wide and narrow terminals", () => {
  for (const width of [40, 60, 80, 120]) {
    const text = formatModels(config, live, 60_000, width);
    const table = text.split("\n").filter((line) => /^[┌│├└]/u.test(line));
    assert.ok(table[0]?.startsWith("┌"), text);
    assert.ok(table.at(-1)?.startsWith("└"), text);
    assert.equal(
      table.filter((line) => line.startsWith("│")).length,
      live.catalog.models.length + 1,
    );
    assert.ok(
      table.every((line) => visibleWidth(line) <= width),
      text,
    );
    assert.ok(
      table.every(
        (line) => visibleWidth(line) === visibleWidth(table[0] ?? ""),
      ),
      text,
    );
    assert.match(table[1] ?? "", /Model/);
    assert.match(text, /Notes:/);
  }
  const hostile = resolveCatalog(
    [{ id: "gpt-模型|evil\u001b[2J\u202e" }],
    config,
    bundledReference,
  );
  const text = formatModels(config, { ...live, catalog: hostile }, 60_000, 60);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u202e]/);
  assert.ok(
    text
      .split("\n")
      .filter((line) => /^[┌│├└]/u.test(line))
      .every((line) => visibleWidth(line) <= 60),
  );
});

test("status shows only this session's GPT transport", () => {
  const other = session(
    "subagent",
    { connected: true, modelId: "gpt-other" },
    { requests: 9, deltaRequests: 8, connectionsOpened: 1, lastError: "x" },
  );
  const gpt = (sessions: TransportSessionStatus[], proxyConfig = config) =>
    status({ sessions }, proxyConfig).split("\n").slice(5).join("\n");

  assert.equal(
    gpt([other]),
    "GPT (this session): idle; the WebSocket opens on the first GPT request",
  );
  assert.equal(
    gpt([
      other,
      session(
        "current",
        { connected: true, continuation: true },
        {
          requests: 3,
          deltaRequests: 2,
          fullRequests: 1,
          connectionsOpened: 1,
        },
      ),
    ]),
    "GPT (this session): WebSocket connected for gpt-6.1-sol; 3 requests, 2 continued, 1 connection",
  );
  assert.equal(
    gpt(
      Array.from({ length: 40 }, (_, index) =>
        session(
          "current",
          { connected: true, modelId: `gpt-${index}` },
          { requests: 1, fullRequests: 1, connectionsOpened: 1 },
        ),
      ),
    ),
    "GPT (this session): WebSocket connected for 40 models; 40 requests, 0 continued, 40 connections",
  );
  assert.equal(
    gpt([
      session(
        "current",
        { websocketPausedUntil: 360_000 },
        { sseRequests: 2, lastFallback: "WebSocket connect failed: 503" },
      ),
    ]),
    [
      "GPT (this session): using HTTP, WebSocket retry in 5m; 2 via HTTP",
      "Last fallback: WebSocket connect failed: 503",
    ].join("\n"),
  );
  assert.equal(
    gpt([
      session(
        "current",
        {},
        {
          requests: 1,
          fullRequests: 1,
          connectionsOpened: 1,
          lastError: "WebSocket idle for 300000ms",
        },
      ),
    ]),
    [
      "GPT (this session): WebSocket closed, reopens on the next GPT request; 1 request, 0 continued, 1 connection",
      "Last WebSocket error: WebSocket idle for 300000ms",
    ].join("\n"),
  );
  assert.equal(
    gpt([other], { ...config, websocket: false }),
    "GPT: HTTP streaming; WebSocket is off in the config",
  );
});

test("status distinguishes cached, checking and failed states without hanging indentation", () => {
  const noKey = status({ auth: { configured: false } });
  assert.match(noKey, /^CLIProxyAPI: not ready \(status snapshot\)\n/);
  assert.match(
    noKey,
    /Key: missing; set CLIPROXYAPI_API_KEY or run \/login proxy/,
  );

  const cachedCatalog = {
    ...live,
    source: "cache" as const,
    scope: "unverified" as const,
  };
  const cached = status({ catalog: cachedCatalog });
  assert.match(cached, /^CLIProxyAPI: cached \(status snapshot\)\n/);
  assert.match(cached, /Models: 34, cached, checked 60s ago/);
  assert.doesNotMatch(cached, /unverified|run \/proxy refresh to verify/);
  assert.match(
    status({ catalog: cachedCatalog, checking: true }),
    /^CLIProxyAPI: checking/,
  );
  assert.match(
    status({ catalog: cachedCatalog, checkError: "offline" }),
    /Check failed: offline; keeping cached models/,
  );
  assert.ok(
    status()
      .split("\n")
      .every((line) => !line.startsWith(" ")),
  );

  const stale = status({
    catalog: { ...live, lastError: { message: "CPA down", at: 0 } },
  });
  assert.match(stale, /^CLIProxyAPI: refresh failed \(status snapshot\)\n/);
  assert.match(stale, /Models: 34, live, checked 60s ago\n/);
  assert.match(
    stale,
    /Last refresh failed 60s ago, using the previous catalog: CPA down\n/,
  );

  const hostile = `boom\u0007\nforged line\u202e ${"x".repeat(500)}`;
  const failed = status({
    catalog: {
      source: "none",
      scope: "unverified",
      notes: [],
      catalog: resolveCatalog([], config, bundledReference),
      lastError: { message: hostile, at: 0 },
    },
    sessions: [session("current", {}, { lastError: hostile })],
  });
  assert.match(failed, /^CLIProxyAPI: not ready \(status snapshot\)\n/);
  assert.match(failed, /Models: none yet; run \/proxy refresh\n/);
  assert.match(
    failed,
    /Last refresh failed 60s ago: boom\?\?forged line\? x+…\n/,
  );
  assert.match(failed, /Last WebSocket error: boom\?\?forged line\? x+…$/);

  const invalid = formatStatus({
    load: {
      status: "invalid",
      path: "/agent/cliproxyapi.json",
      error: Array.from({ length: 20 }, () => hostile).join("\n"),
    },
  });
  assert.match(invalid, /\(36 more lines\)\nFix the file and run \/reload\.$/);
  const unregistered = formatStatus({
    load: { status: "ok", config },
    setupError: hostile,
  });
  assert.match(unregistered, /^CLIProxyAPI: not registered\nboom\?\?/);

  // Even with every problem at once, status stays a fixed handful of bounded lines.
  for (const text of [failed, invalid, unregistered]) {
    const lines = text.split("\n");
    assert.ok(lines.length <= 8, text);
    assert.ok(
      lines.every((line) => [...line].length <= 200),
      text,
    );
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u202e]/);
  }
});
