import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";

type Response = {
  text?: string;
  error?: string;
  usage?: AssistantMessage["usage"];
};

async function fixture(
  t: TestContext,
  responses: readonly Response[],
  compaction = { enabled: true, keepRecentTokens: 20_000 },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backend-"));
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENT_STATE_DIR: process.env.PI_SUBAGENT_STATE_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
  };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_SUBAGENT_STATE_DIR = path.join(root, "state");
  process.env.PI_OFFLINE = "1";
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ compaction, retry: { enabled: false } }),
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
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Only provider responses/auth are replaced. Compaction, retries, persistence,
  // backend event translation and manager settlement all use their real paths.
  t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => true);
  t.mock.method(ModelRuntime.prototype, "getAuth", async () => undefined);
  let requests = 0;
  t.mock.method(
    ModelRuntime.prototype,
    "streamSimple",
    (model: Parameters<ModelRuntime["streamSimple"]>[0]) => {
      const response = responses[requests++];
      assert.ok(response, "Unexpected provider request");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: response.text ? [{ type: "text", text: response.text }] : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: response.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: response.error ? "error" : "stop",
        errorMessage: response.error,
        timestamp: Date.now(),
      };
      stream.push(
        response.error
          ? { type: "error", reason: "error", error: message }
          : { type: "done", reason: "stop", message },
      );
      stream.end();
      return stream;
    },
  );
  const models = await ModelRuntime.create({
    authPath: path.join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(models);
  const model = registry.getAll().find((m) => m.provider === "openai");
  assert.ok(model);
  const parent = {
    parentCwd: root,
    parentSessionId: "backend-test",
    projectTrusted: false,
    modelRegistry: registry,
  };
  let manager = await runtime.runPromise(SubagentManager);
  const wait = async (id: string) => {
    const result = await runtime.runPromise(
      manager.waitFor([id], "all", undefined, 5_000),
    );
    assert.equal(result.timedOut, false);
    const snapshot = manager.view.get(id);
    assert.ok(snapshot);
    return snapshot;
  };
  return {
    requests: () => requests,
    async spawn(prompt: string) {
      const { id } = await runtime.runPromise(
        manager.spawn("pi", {
          prompt,
          title: "backend fixture",
          cwd: root,
          model: `${model.provider}/${model.id}`,
          reasoningEffort: "off",
          parent,
        }),
      );
      return wait(id);
    },
    async send(id: string, prompt: string) {
      // send() returns before the event pump marks an idle session running.
      // Wait for its next settlement, not the previous run's cached snapshot.
      const settled = new Promise<void>((resolve) => {
        manager.view.setOnSettled(() => resolve());
      });
      await runtime.runPromise(manager.send(id, prompt));
      await settled;
      return wait(id);
    },
    async restoreAndContinue(id: string, prompt: string) {
      await runtime.dispose();
      runtime = createRuntime();
      manager = await runtime.runPromise(SubagentManager);
      await runtime.runPromise(manager.restore(parent.parentSessionId, root));
      await runtime.runPromise(
        manager.resume(id, prompt, parent, "continuation"),
      );
      return wait(id);
    },
  };
}

test("Pi persists the final response usage, including after artifact continuation", async (t) => {
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
  const response = { text: "Completed fixture task.", usage };
  const f = await fixture(t, [response, response], {
    enabled: false,
    keepRecentTokens: 20_000,
  });
  const first = await f.spawn("Complete the fixture task.");
  assert.equal(first.status, "done", first.errorText ?? "Initial run failed");
  assert.equal(first.usage.inputTokens, usage.input);
  assert.equal(first.usage.outputTokens, usage.output);
  assert.equal(first.usage.costUsd, usage.cost.total);
  const resumed = await f.restoreAndContinue(
    first.id,
    "Continue the fixture task.",
  );
  assert.equal(
    resumed.status,
    "done",
    resumed.errorText ?? "Continuation failed",
  );
  assert.notEqual(resumed.meta.sessionFilePath, first.meta.sessionFilePath);
  assert.equal(resumed.usage.inputTokens, usage.input);
  assert.equal(resumed.usage.outputTokens, usage.output);
  assert.equal(resumed.usage.costUsd, usage.cost.total);
  const receipt = JSON.parse(
    fs.readFileSync(resumed.artifacts.receipt, "utf8"),
  );
  assert.deepEqual(receipt.usage, resumed.usage);
  assert.equal(f.requests(), 2);
});

const OVERFLOW = "maximum context length exceeded";
const SUMMARY = "The user wants the fixture task completed.";
const LONG_PROMPT = "Complete the fixture task. ".repeat(100);

for (const scenario of [
  {
    name: "there is nothing to compact",
    prompt: "Complete the fixture task.",
    keepRecentTokens: 20_000,
    responses: [{ error: OVERFLOW, text: "Partial work." }],
  },
  {
    name: "summary generation fails",
    prompt: LONG_PROMPT,
    keepRecentTokens: 16,
    responses: [
      { error: OVERFLOW, text: "Partial work." },
      { error: "Summary provider unavailable" },
    ],
  },
]) {
  test(`Pi reports failed overflow recovery when ${scenario.name}`, async (t) => {
    const f = await fixture(t, scenario.responses, {
      enabled: true,
      keepRecentTokens: scenario.keepRecentTokens,
    });
    const result = await f.spawn(scenario.prompt);
    assert.equal(f.requests(), scenario.responses.length);
    assert.ok(result.meta.sessionFilePath);
    const history = SessionManager.open(result.meta.sessionFilePath);
    assert.ok(
      history.getEntries().some((entry) => entry.type === "context_edit"),
    );
    assert.equal(
      history
        .buildSessionContext()
        .messages.some(
          (message) =>
            message.role === "assistant" && message.stopReason === "error",
        ),
      false,
      "The error is omitted from model context, not from the run outcome",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorText, OVERFLOW);
    assert.equal(result.finalText, "Partial work.");
  });
}

test("Pi compacts and continues after overflow, replacing the failed attempt's outcome", async (t) => {
  const f = await fixture(
    t,
    [
      { error: OVERFLOW },
      { text: SUMMARY },
      { text: "Completed after compaction." },
    ],
    { enabled: true, keepRecentTokens: 16 },
  );
  const result = await f.spawn(LONG_PROMPT);
  assert.equal(f.requests(), 3);
  assert.equal(result.status, "done", result.errorText ?? "Recovery failed");
  assert.equal(result.errorText, undefined);
  assert.equal(result.finalText, "Completed after compaction.");
  assert.ok(result.meta.sessionFilePath);
  const history = SessionManager.open(result.meta.sessionFilePath);
  assert.ok(
    history
      .getEntries()
      .some(
        (entry) =>
          entry.type === "compaction" && entry.summary.includes(SUMMARY),
      ),
  );
});

test(
  "Pi does not reuse output or errors from previous runs on the same session",
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, [
      { text: "Earlier answer." },
      { error: OVERFLOW },
      { text: "Fresh answer." },
    ]);
    const first = await f.spawn("First task.");
    assert.equal(first.status, "done");
    const failed = await f.send(first.id, "Second task.");
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorText, OVERFLOW);
    assert.equal(failed.finalText, "");
    const recovered = await f.send(first.id, "Try again.");
    assert.equal(
      recovered.status,
      "done",
      recovered.errorText ?? "Fresh run failed",
    );
    assert.equal(recovered.errorText, undefined);
    assert.equal(recovered.finalText, "Fresh answer.");
    assert.equal(f.requests(), 3);
  },
);
