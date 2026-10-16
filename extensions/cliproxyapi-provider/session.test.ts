import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
