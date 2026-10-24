import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { startMockCpa } from "./mock-cpa.ts";

type Json = { readonly [key: string]: unknown };
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

test("a Pi session uses the extension's provider, tools and WebSocket continuation", async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "cpa-session-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CPA_SESSION_TEST_KEY = "session-key";
  const mock = await startMockCpa({
    apiKey: "session-key",
    models: [
      { id: "gpt-6.1-sol", owned_by: "openai" },
      { id: "go/claude-haiku-5-5" },
    ],
    reply: (items) => {
      const last = items.at(-1);
      if (isJson(last) && last.type === "function_call_output")
        return { text: `tool said ${String(last.output)}` };
      const asked = JSON.stringify(items.at(-1));
      return asked.includes("echo")
        ? {
            toolCall: {
              name: "echo",
              arguments: JSON.stringify({ text: "héllo 🌍", note: null }),
            },
          }
        : { text: "second answer ✓" };
    },
  });
  t.after(async () => {
    await mock.close();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    delete process.env.CPA_SESSION_TEST_KEY;
  });
  await writeFile(
    path.join(agentDir, "cliproxyapi.json"),
    JSON.stringify({
      baseUrl: `${mock.root}/v1`,
      provider: "cpa-test",
      apiKeyEnv: "CPA_SESSION_TEST_KEY",
    }),
  );

  const received: unknown[] = [];
  const echo = defineTool({
    name: "echo",
    label: "Echo",
    description: "Echo text",
    parameters: Type.Object({
      text: Type.String(),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      received.push(params);
      return {
        content: [{ type: "text", text: `echo:${params.text}` }],
        details: undefined,
      };
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [path.join(import.meta.dirname, "index.ts")],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: agentDir,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(agentDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    customTools: [echo],
    noTools: "builtin",
  });
  t.after(() => session.dispose());

  const model = session.modelRuntime.getModel("cpa-test", "gpt-6.1-sol");
  assert.ok(model, "first use discovered the CPA catalog");
  assert.equal(
    session.modelRuntime.getModel("cpa-test", "go/claude-haiku-5-5"),
    undefined,
  );
  await session.setModel(model);

  await session.prompt("please echo something");
  // Pi drops the null optional field before the tool runs.
  assert.deepEqual(received, [{ text: "héllo 🌍" }]);
  await session.prompt("and again");
  assert.equal(session.getLastAssistantText(), "second answer ✓");
  assert.deepEqual(
    mock.requests.map((request) => [
      request.transport,
      request.connection,
      request.delta,
    ]),
    [
      ["websocket", 1, false],
      ["websocket", 1, true],
      ["websocket", 1, true],
    ],
  );
  const toolOutput = mock.requests[1]?.merged.at(-1);
  assert.ok(isJson(toolOutput) && toolOutput.output === "echo:héllo 🌍");

  const command = session.extensionRunner.getCommand("proxy");
  assert.ok(command);
  assert.deepEqual(await command.getArgumentCompletions?.(""), [
    { value: "models", label: "models" },
    { value: "refresh", label: "refresh" },
  ]);
  assert.equal(await command.getArgumentCompletions?.("refresh"), null);
  assert.equal(await command.getArgumentCompletions?.("models"), null);
  assert.ok(
    (await command.getArgumentCompletions?.("ref"))?.some(
      (item) => item.value === "refresh",
    ),
  );
  const ctx = session.extensionRunner.createCommandContext();
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const ui = {
    ...ctx.ui,
    notify: (message: string) => {
      notifications.push(message);
    },
    setStatus: (_key: string, text: string | undefined) => {
      statuses.push(text);
    },
  };
  const commandContext = { ...ctx, hasUI: true, ui };
  const registry = ctx.modelRegistry;
  const originalRefresh = registry.refresh;
  let complete:
    | ((result: Awaited<ReturnType<typeof registry.refresh>>) => void)
    | undefined;
  const pending = new Promise<Awaited<ReturnType<typeof registry.refresh>>>(
    (resolve) => {
      complete = resolve;
    },
  );
  assert.ok(complete);
  registry.refresh = () => pending;
  const refreshing = command.handler("refresh", commandContext);
  try {
    assert.match(notifications[0] ?? "", /^Refreshing CPA models/);
    assert.deepEqual(statuses, []);
    await command.handler("refresh", commandContext);
    assert.match(notifications.at(-1) ?? "", /already in progress/);
  } finally {
    complete({ aborted: false, errors: new Map() });
    await refreshing;
    registry.refresh = originalRefresh;
  }
  assert.match(notifications.at(-1) ?? "", /catalog refreshed/);
  assert.deepEqual(statuses, []);
  registry.refresh = async () => ({
    aborted: false,
    errors: new Map([["cpa-test", new Error("offline")]]),
  });
  try {
    await command.handler("refresh", commandContext);
    assert.match(
      notifications.at(-1) ?? "",
      /refresh failed: offline; keeping the previous catalog/,
    );
    assert.deepEqual(statuses, []);
    registry.refresh = async () => {
      throw new Error("status must not make a network request");
    };
    notifications.length = 0;
    await command.handler("", commandContext);
    assert.match(notifications[0] ?? "", /status snapshot/);
  } finally {
    registry.refresh = originalRefresh;
  }

  // RPC has no built-in interactive-mode catalog refresher: the extension must do it.
  const runner = session.extensionRunner;
  // Finish the real auth snapshot before replacing refresh with a recording stub.
  await registry.refresh({ providers: ["cpa-test"], allowNetwork: false });
  const network: boolean[] = [];
  registry.refresh = async (options) => {
    network.push(options?.allowNetwork === true);
    return { aborted: false, errors: new Map() };
  };
  runner.setUIContext(ui, "tui");
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    await setImmediate();
    assert.deepEqual(
      network,
      [false],
      "TUI startup restores only; Pi owns the single background refresh",
    );
    network.length = 0;
    runner.setUIContext(ui, "rpc");
    await runner.emit({ type: "session_start", reason: "reload" });
    await setImmediate();
    assert.ok(
      network.includes(true),
      "RPC/reload uses a non-forced catalog check when Pi has no startup refresher",
    );
    network.length = 0;
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try {
      await runner.emit({ type: "session_start", reason: "reload" });
      await setImmediate();
      assert.ok(
        !network.includes(true),
        "offline startup must not contact the server",
      );
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
    assert.deepEqual(statuses, []);
  } finally {
    registry.refresh = originalRefresh;
    runner.setUIContext(undefined, ctx.mode);
  }
});
