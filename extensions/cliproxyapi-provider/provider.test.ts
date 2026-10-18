import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createModels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { startMockCpa } from "./mock-cpa.ts";
import type { ProxyConfig } from "./src/config.ts";
import { createProxyProvider } from "./src/provider.ts";

let envCounter = 0;

function keyEnv(t: TestContext, value: string): string {
  const name = `CPA_PROVIDER_TEST_KEY_${++envCounter}`;
  process.env[name] = value;
  t.after(() => delete process.env[name]);
  return name;
}

const config = (root: string, apiKeyEnv: string): ProxyConfig => ({
  path: "test",
  provider: "proxy",
  name: "CLIProxyAPI",
  root,
  apiKeyEnv,
  websocket: true,
  routes: {},
});

const models = [
  { id: "gpt-6.1-sol", owned_by: "openai" },
  { id: "claude-opus-5-5", owned_by: "anthropic" },
  { id: "go/claude-haiku-5-5", owned_by: "opencode-go" },
];

test("caches discovery per endpoint and key, and keeps it through failed refreshes", async (t) => {
  const mock = await startMockCpa({
    apiKey: "key-a",
    models,
    reply: () => ({ text: "ok" }),
  });
  t.after(() => mock.close());
  const store = new InMemoryModelsStore();
  const env = keyEnv(t, "key-a");
  const runtime = (root = mock.root) => {
    const proxy = createProxyProvider(config(root, env));
    const collection = createModels({
      modelsStore: store,
      credentials: new InMemoryCredentialStore(),
    });
    collection.setProvider(proxy.provider);
    return { proxy, collection };
  };

  const live = runtime();
  assert.equal(
    (await live.collection.refresh({ allowNetwork: true })).errors.size,
    0,
  );
  assert.deepEqual(
    live.collection.getModels("proxy").map((model) => model.id),
    ["gpt-6.1-sol", "claude-opus-5-5"],
  );
  assert.equal(
    live.proxy.status().catalog.hidden[0]?.id,
    "go/claude-haiku-5-5",
  );

  // A malformed list must not replace the good catalog.
  mock.modelsResponse = { object: "list", data: [{ object: "model" }, 7] };
  const failed = await live.collection.refresh({
    allowNetwork: true,
    force: true,
  });
  assert.match(failed.errors.get("proxy")?.message ?? "", /without a valid id/);
  assert.equal(live.collection.getModels("proxy").length, 2);
  assert.equal(live.proxy.status().source, "live");

  // Offline restart with the same key restores; another key or endpoint does not.
  const restarted = runtime();
  await restarted.collection.refresh({ allowNetwork: false });
  assert.equal(restarted.collection.getModels("proxy").length, 2);
  assert.equal(restarted.proxy.status().scope, "verified");

  process.env[env] = "key-b";
  const otherKey = runtime();
  await otherKey.collection.refresh({ allowNetwork: false });
  assert.equal(otherKey.collection.getModels("proxy").length, 0);
  assert.match(otherKey.proxy.status().notes.join(), /another key/);

  process.env[env] = "key-a";
  const otherEndpoint = runtime("http://127.0.0.1:9");
  await otherEndpoint.collection.refresh({ allowNetwork: false });
  assert.equal(otherEndpoint.collection.getModels("proxy").length, 0);
  assert.match(otherEndpoint.proxy.status().notes.join(), /another endpoint/);

  // An empty list is a real answer and clears the catalog.
  mock.modelsResponse = { object: "list", data: [] };
  await live.collection.refresh({ allowNetwork: true, force: true });
  assert.equal(live.collection.getModels("proxy").length, 0);
});

test("a key the cache cannot verify offline still cannot restore another endpoint", async (t) => {
  const mock = await startMockCpa({
    apiKey: "key-a",
    models,
    reply: () => ({ text: "ok" }),
  });
  t.after(() => mock.close());
  const store = new InMemoryModelsStore();
  const env = keyEnv(t, "key-a");
  const first = createProxyProvider(config(mock.root, env));
  const collection = createModels({ modelsStore: store });
  collection.setProvider(first.provider);
  await collection.refresh({ allowNetwork: true });

  delete process.env[env];
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("proxy", async () => ({
    type: "api_key",
    key: "!op read secret",
  }));
  for (const [root, expected] of [
    [mock.root, 2],
    ["http://127.0.0.1:9", 0],
  ] as const) {
    const proxy = createProxyProvider(config(root, env));
    const offline = createModels({ modelsStore: store, credentials });
    offline.setProvider(proxy.provider);
    await offline.refresh({ allowNetwork: false });
    assert.equal(offline.getModels("proxy").length, expected, root);
    if (expected) assert.equal(proxy.status().scope, "unverified");
  }
});

test("first use discovers before registration and later starts read Pi's store file", async (t) => {
  const mock = await startMockCpa({
    apiKey: "key-a",
    models,
    reply: () => ({ text: "ok" }),
  });
  t.after(() => mock.close());
  const env = keyEnv(t, "key-a");
  const dir = await mkdtemp(path.join(tmpdir(), "cpa-store-"));
  const storeFile = path.join(dir, "models-store.json");

  const fresh = createProxyProvider(config(mock.root, env));
  await fresh.initialize(storeFile);
  assert.equal(fresh.provider.getModels().length, 2);
  const store = new InMemoryModelsStore();
  const collection = createModels({ modelsStore: store });
  collection.setProvider(fresh.provider);
  await collection.refresh({ allowNetwork: false });
  const persisted = await store.read("proxy");
  assert.equal(persisted?.models.length, 2);

  await writeFile(storeFile, JSON.stringify({ proxy: persisted }));
  // Any rediscovery would now publish an empty catalog.
  mock.modelsResponse = { object: "list", data: [] };
  delete process.env[env];
  const cached = createProxyProvider(config(mock.root, env));
  await cached.initialize(storeFile);
  assert.equal(cached.provider.getModels().length, 2);
  assert.equal(cached.status().source, "cache");
  assert.equal(cached.status().scope, "unverified");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("proxy", async () => ({
    type: "api_key",
    key: "key-a",
  }));
  const restored = createModels({ modelsStore: store, credentials });
  restored.setProvider(cached.provider);
  await restored.refresh({ allowNetwork: false });
  assert.equal(
    cached.status().scope,
    "verified",
    "a matching resolved key verifies the existing cache without fetching models",
  );
});

test("discovery errors never echo the client key", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(500);
    response.end(`upstream rejected ${request.headers.authorization}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const env = keyEnv(t, "sk-very-secret-key");
  const proxy = createProxyProvider(config(`http://127.0.0.1:${port}`, env));
  const collection = createModels({ modelsStore: new InMemoryModelsStore() });
  collection.setProvider(proxy.provider);
  const result = await collection.refresh({ allowNetwork: true });
  const message = result.errors.get("proxy")?.message ?? "";
  assert.match(message, /HTTP 500: upstream rejected Bearer \[redacted\]/);
  assert.doesNotMatch(
    message + JSON.stringify(proxy.status()),
    /sk-very-secret-key/,
  );
});
