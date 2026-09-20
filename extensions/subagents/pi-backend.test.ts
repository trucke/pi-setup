import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";

test("Pi persists the final response usage, including after artifact continuation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backend-usage-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldStateDir = process.env.PI_SUBAGENT_STATE_DIR;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_SUBAGENT_STATE_DIR = path.join(root, "state");
  process.env.PI_OFFLINE = "1";
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const usage = {
    input: 123,
    output: 17,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 140,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    },
  };
  // Replace only the provider boundary. The real SDK event/persistence ordering,
  // Pi adapter and manager run normally, without network calls or real credentials.
  t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
  t.mock.method(
    ModelRuntime.prototype,
    "streamSimple",
    (model: Parameters<ModelRuntime["streamSimple"]>[0]) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Completed fixture task." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  );
  const createRuntime = () =>
    ManagedRuntime.make(
      SubagentManagerLive.pipe(
        Layer.provide(
          Layer.succeed(BackendRegistry, new Map([["pi", piBackend]])),
        ),
      ),
    );
  let runtime = createRuntime();
  try {
    const models = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(models);
    const model = registry
      .getAll()
      .find((candidate) => candidate.provider === "openai")!;
    assert.ok(model);
    const parent = {
      parentCwd: root,
      parentSessionId: "usage-test",
      projectTrusted: false,
      modelRegistry: registry,
    };
    let manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", {
        prompt: "Complete the fixture task.",
        title: "usage",
        cwd: root,
        model: `${model.provider}/${model.id}`,
        reasoningEffort: "off",
        parent,
      }),
    );
    await runtime.runPromise(manager.waitFor([spawned.id]));
    const first = manager.view.get(spawned.id)!;
    assert.equal(first.status, "done", first.errorText ?? "initial run failed");
    assert.equal(first.usage.inputTokens, usage.input);
    assert.equal(first.usage.outputTokens, usage.output);
    assert.equal(first.usage.costUsd, usage.cost.total);
    await runtime.dispose();
    runtime = createRuntime();
    manager = await runtime.runPromise(SubagentManager);
    await runtime.runPromise(manager.restore(parent.parentSessionId, root));
    await runtime.runPromise(
      manager.resume(
        spawned.id,
        "Continue the fixture task.",
        parent,
        "continuation",
      ),
    );
    await runtime.runPromise(manager.waitFor([spawned.id]));
    const resumed = manager.view.get(spawned.id)!;
    assert.equal(
      resumed.status,
      "done",
      resumed.errorText ?? "continuation failed",
    );
    assert.notEqual(resumed.meta.sessionFilePath, first.meta.sessionFilePath);
    assert.equal(resumed.usage.inputTokens, usage.input);
    assert.equal(resumed.usage.outputTokens, usage.output);
    assert.equal(resumed.usage.costUsd, usage.cost.total);
    const receipt = JSON.parse(
      fs.readFileSync(resumed.artifacts.receipt, "utf8"),
    );
    assert.deepEqual(receipt.usage, resumed.usage);
  } finally {
    await runtime.dispose();
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: oldAgentDir,
      PI_SUBAGENT_STATE_DIR: oldStateDir,
      PI_OFFLINE: oldOffline,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
