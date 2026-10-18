import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hasApi } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import {
  fromStoreEntry,
  resolveCatalog,
  toStoreEntry,
  type DiscoveredModel,
} from "./src/catalog.ts";
import {
  findModelsJsonConflict,
  parseConfig,
  type ProxyConfig,
} from "./src/config.ts";
import { bundledReference } from "./src/provider.ts";
import { continuationDelta, type Continuation } from "./src/responses.ts";

const config = (routes: ProxyConfig["routes"] = {}): ProxyConfig => ({
  path: "test",
  provider: "proxy",
  name: "CLIProxyAPI",
  root: "http://cpa.test",
  apiKeyEnv: "CLIPROXYAPI_API_KEY",
  websocket: true,
  routes,
});

const parse = (text: string) =>
  Effect.runPromise(Effect.result(parseConfig("cliproxyapi.json", text)));

test("config accepts the CPA root or /v1 URL and rejects typos and inline keys", async () => {
  const ok = await parse(
    '{"baseUrl": "https://cpa.example/base/v1/", "provider": "proxy"}',
  );
  assert.equal(ok._tag, "Success");
  if (ok._tag === "Success") {
    assert.equal(ok.success.root, "https://cpa.example/base");
    assert.equal(ok.success.apiKeyEnv, "CLIPROXYAPI_API_KEY");
  }
  for (const text of [
    '{"baseUrl": "http://cpa.test", "websockets": false}',
    '{"baseUrl": "http://cpa.test", "apiKeyEnv": "sk-live-123"}',
    '{"baseUrl": "http://user:secret@cpa.test"}',
    '{"baseUrl": "http://cpa.test", "routes": {"x": {"api": "openai-completions"}}}',
  ]) {
    assert.equal((await parse(text))._tag, "Failure", text);
  }
});

test("a models.json provider with its own endpoint or models blocks registration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpa-config-"));
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        proxy: { baseUrl: "http://old", models: [{ id: "gpt-6.1-sol" }] },
        tuned: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 1 } } },
      },
    }),
  );
  assert.match(
    (await findModelsJsonConflict(dir, "proxy")) ?? "",
    /models, baseUrl/,
  );
  assert.equal(await findModelsJsonConflict(dir, "tuned"), undefined);
  assert.equal(await findModelsJsonConflict(dir, "cliproxyapi"), undefined);
});

const discovered: DiscoveredModel[] = [
  {
    id: "gpt-6.1-sol",
    ownedBy: "openai",
    cpa: {
      contextWindow: 500_000,
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      input: ["text", "image"],
    },
  },
  { id: "gpt-6.1-sol-fast", ownedBy: "openai" },
  {
    id: "claude-opus-5-5",
    ownedBy: "anthropic",
    cpa: { contextWindow: 500_000, reasoningLevels: [] },
  },
  { id: "go/claude-haiku-5-5", ownedBy: "opencode-go" },
  { id: "gemini-9-pro" },
];

test("routes only bare GPT and Claude ids, with CPA limits and Pi catalog metadata", () => {
  const catalog = resolveCatalog(discovered, config(), bundledReference);
  assert.deepEqual(
    catalog.hidden.map((entry) => entry.id),
    ["go/claude-haiku-5-5", "gemini-9-pro"],
  );
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const info = new Map(catalog.routes.map((route) => [route.id, route]));

  const sol = byId.get("gpt-6.1-sol");
  assert.ok(sol && hasApi(sol, "openai-responses"));
  assert.equal(sol.baseUrl, "http://cpa.test/v1");
  assert.equal(sol.contextWindow, 500_000);
  assert.deepEqual(sol.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  });
  // Request-shape flags come from the reference; mid-conversation features need a route opt-in.
  assert.equal(sol.compat?.supportsStrictMode, true);
  assert.equal(sol.compat?.supportsMidConvoEffort, undefined);
  assert.equal(sol.compat?.supportsToolSearch, undefined);
  assert.equal(info.get("gpt-6.1-sol")?.reference, "openai/gpt-6.1-sol");
  assert.match(
    info.get("gpt-6.1-sol")?.warnings.join() ?? "",
    /272000; using CPA's route value/,
  );

  // An alias without catalog metadata stays conservative and says so.
  const fast = byId.get("gpt-6.1-sol-fast");
  assert.ok(fast);
  assert.deepEqual(
    [fast.reasoning, fast.input, fast.contextWindow, fast.cost.input],
    [false, ["text"], 128_000, 0],
  );
  assert.match(
    info.get("gpt-6.1-sol-fast")?.warnings.join() ?? "",
    /does not mean free/,
  );

  // Claude: Pi appends /v1/messages to the root; CPA's Codex-style levels are not used.
  const opus = byId.get("claude-opus-5-5");
  assert.ok(opus && hasApi(opus, "anthropic-messages"));
  assert.equal(opus.baseUrl, "http://cpa.test");
  assert.equal(opus.reasoning, true);
  assert.equal(opus.compat?.forceAdaptiveThinking, true);
  assert.equal(opus.compat?.supportsMidConvoEffort, undefined);
  assert.equal(opus.contextWindow, 500_000);
  assert.match(
    info.get("claude-opus-5-5")?.warnings.join() ?? "",
    /lists 1000000; using the smaller value/,
  );
});

test("explicit routes win over inference, CPA and catalog data", () => {
  const catalog = resolveCatalog(
    discovered,
    config({
      "gpt-6.1-sol-fast": {
        metadata: "openai/gpt-6.1-sol",
        contextWindow: 400_000,
        compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
      },
      "go/claude-haiku-5-5": {
        api: "anthropic-messages",
        metadata: "anthropic/claude-haiku-5-5",
      },
      "gemini-9-pro": {
        api: "openai-responses",
        metadata: null,
        reasoning: true,
        thinkingLevelMap: { high: "high" },
      },
      "gpt-retired": { api: "openai-responses" },
    }),
    bundledReference,
  );
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const fast = byId.get("gpt-6.1-sol-fast");
  assert.ok(fast && hasApi(fast, "openai-responses"));
  assert.equal(fast.contextWindow, 400_000);
  assert.equal(fast.reasoning, true);
  assert.equal(fast.cost.input, 2);
  assert.equal(fast.compat?.supportsMidConvoEffort, true);
  assert.match(
    catalog.routes
      .find((route) => route.id === "gpt-6.1-sol-fast")
      ?.warnings.join() ?? "",
    /forceAdaptiveThinking ignored/,
  );
  assert.equal(byId.get("go/claude-haiku-5-5")?.api, "anthropic-messages");
  assert.deepEqual(byId.get("gemini-9-pro")?.thinkingLevelMap, {
    high: "high",
  });
  assert.deepEqual(catalog.warnings, [
    "route gpt-retired is configured but CPA does not offer it",
  ]);
});

test("persisted catalogs keep their endpoint and credential scope and reject mixed entries", () => {
  const catalog = resolveCatalog(discovered, config(), bundledReference);
  const entry = toStoreEntry(
    catalog,
    discovered,
    { endpoint: "http://cpa.test", credential: "abc" },
    42,
  );
  const restored = fromStoreEntry(JSON.parse(JSON.stringify(entry)));
  assert.equal(restored?.endpoint, "http://cpa.test");
  assert.equal(restored?.credential, "abc");
  assert.deepEqual(
    restored?.discovered.map((model) => model.id),
    ["gpt-6.1-sol", "gpt-6.1-sol-fast", "claude-opus-5-5"],
  );
  assert.deepEqual(restored?.discovered[0]?.cpa, discovered[0]?.cpa);

  const [first, ...rest] = entry.models;
  const mixed = {
    models: [
      {
        ...first,
        cliproxyapi: { v: 1, endpoint: "http://other", credential: "abc" },
      },
      ...rest,
    ],
  };
  assert.equal(fromStoreEntry(mixed), undefined);
  assert.equal(fromStoreEntry({ models: [{ id: "x" }] }), undefined);
});

test("continuations require the exact prior request and an unchanged replay of its output", () => {
  const prior = [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  const output = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "héllo 🌍", annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "read",
    arguments: '{"path": "a"}',
  };
  const continuation: Continuation = {
    options: JSON.stringify({ model: "gpt-6.1-sol", stream: true }),
    input: prior.map((item) => JSON.stringify(item)),
    output: [output, call],
    responseId: "resp_1",
  };
  const replayedMessage = { ...output, phase: undefined };
  const replayedCall = { ...call, arguments: '{"path":"a"}' };
  const next = {
    type: "function_call_output",
    call_id: "call_1",
    output: "ok",
  };
  const body = (input: unknown[], extra = {}) => ({
    model: "gpt-6.1-sol",
    stream: true,
    ...extra,
    input,
  });

  assert.deepEqual(
    continuationDelta(
      body([...prior, replayedMessage, replayedCall, next]),
      continuation,
    ),
    [next],
  );

  // Each rewrite of the shared history, or of the request options, forces a full request.
  for (const changed of [
    body([...prior, { ...replayedMessage, role: "user" }, replayedCall, next]),
    body([
      ...prior,
      { ...replayedMessage, phase: "commentary" },
      replayedCall,
      next,
    ]),
    body([
      ...prior,
      { ...replayedMessage, content: [{ type: "output_text", text: "hello" }] },
      replayedCall,
      next,
    ]),
    body([
      ...prior,
      replayedMessage,
      { ...replayedCall, namespace: "mcp" },
      next,
    ]),
    body([
      ...prior,
      replayedMessage,
      { ...replayedCall, arguments: '{"path":"b"}' },
      next,
    ]),
    body([
      { role: "user", content: [{ type: "input_text", text: "edited" }] },
      replayedMessage,
      replayedCall,
      next,
    ]),
    body([...prior, replayedMessage, replayedCall, next], { tools: [] }),
    body([...prior, replayedMessage, replayedCall]),
  ]) {
    assert.equal(continuationDelta(changed, continuation), undefined);
  }
});

test("extension code imports only Pi modules the host provides", async () => {
  // Pi maps these specifiers to its own instance; other subpaths would load a second SDK copy,
  // which installed packages do not have and the compiled binary cannot resolve.
  const virtual = await readFile(
    path.join(
      import.meta.dirname,
      "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/virtual-modules.js",
    ),
    "utf8",
  );
  const provided = new Set(
    [...virtual.matchAll(/"(@earendil-works\/[^"]+)":/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(provided.has("@earendil-works/pi-ai/compat"));
  const files = [
    "index.ts",
    ...(await readdir(path.join(import.meta.dirname, "src"))).map(
      (file) => `src/${file}`,
    ),
  ];
  for (const file of files) {
    const source = await readFile(path.join(import.meta.dirname, file), "utf8");
    for (const [, specifier] of source.matchAll(
      /^import (?!type )[^;]*?from "(@earendil-works\/[^"]+)"/gms,
    )) {
      assert.ok(
        provided.has(specifier ?? ""),
        `${file} imports ${specifier}, which Pi does not provide`,
      );
    }
  }
});
