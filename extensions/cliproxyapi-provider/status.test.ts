import assert from "node:assert/strict";
import test from "node:test";
import { resolveCatalog } from "./src/catalog.ts";
import type { ProxyConfig } from "./src/config.ts";
import { bundledReference } from "./src/provider.ts";
import { formatModels, formatStatus } from "./src/status.ts";

const config: ProxyConfig = {
  path: "/agent/cliproxyapi.json",
  provider: "proxy",
  name: "CLIProxyAPI",
  root: "http://cpa.test",
  apiKeyEnv: "CLIPROXYAPI_API_KEY",
  websocket: true,
  routes: {},
};
const controls = /[\u0000-\u0009\u000b-\u001f\u202e]/;

test("model output sanitizes untrusted model ids", () => {
  const catalog = resolveCatalog(
    [{ id: "gpt-模型|evil\u001b[2J\u202e" }],
    config,
    bundledReference,
  );
  const text = formatModels(
    config,
    {
      source: "live",
      scope: "verified",
      notes: [],
      catalog,
    },
    60_000,
    60,
  );
  assert.match(text, /evil/);
  assert.doesNotMatch(text, controls);
});

test("status bounds and sanitizes provider and configuration errors", () => {
  const hostile = `boom\u0007\nforged line\u202e ${"x".repeat(500)}`;
  const failed = formatStatus({
    load: { status: "ok", config },
    registered: {
      auth: {
        configured: true,
        source: "environment",
        label: "CLIPROXYAPI_API_KEY",
      },
      catalog: {
        source: "none",
        scope: "unverified",
        notes: [],
        catalog: resolveCatalog([], config, bundledReference),
        lastError: { message: hostile, at: 0 },
      },
      sessionId: "current",
      sessions: [
        {
          sessionId: "current",
          modelId: "gpt-test",
          connected: false,
          continuation: false,
          stats: {
            requests: 0,
            fullRequests: 0,
            deltaRequests: 0,
            connectionsOpened: 0,
            sseRequests: 0,
            lastError: hostile,
          },
        },
      ],
    },
    now: 60_000,
  });
  const invalid = formatStatus({
    load: {
      status: "invalid",
      path: config.path,
      error: Array.from({ length: 20 }, () => hostile).join("\n"),
    },
  });
  const unregistered = formatStatus({
    load: { status: "ok", config },
    setupError: hostile,
  });
  for (const text of [failed, invalid, unregistered]) {
    assert.match(text, /boom/);
    const lines = text.split("\n");
    assert.ok(lines.length <= 8, text);
    assert.ok(
      lines.every((line) => [...line].length <= 200),
      text,
    );
    assert.doesNotMatch(text, controls);
  }
});
