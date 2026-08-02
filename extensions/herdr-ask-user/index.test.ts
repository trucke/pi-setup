import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrAskUser from "./index.ts";

type Handler = (event: Record<string, unknown>) => void;

type EmittedEvent = {
  name: string;
  data: unknown;
};

function createHarness() {
  const handlers = new Map<string, Handler>();
  const emitted: EmittedEvent[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    events: {
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
      },
    },
  } as unknown as ExtensionAPI;

  herdrAskUser(pi);

  function emit(name: string, event: Record<string, unknown>) {
    const handler = handlers.get(name);
    assert.ok(handler, `missing ${name} handler`);
    handler(event);
  }

  return { emit, emitted };
}

test("reports ask_user execution as blocked until it ends", () => {
  const { emit, emitted } = createHarness();

  emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask_user",
    args: {},
  });
  emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "ask-1",
    toolName: "ask_user",
    result: {},
    isError: false,
  });

  assert.deepEqual(emitted, [
    {
      name: "herdr:blocked",
      data: { active: true, label: "Waiting for your answer" },
    },
    { name: "herdr:blocked", data: { active: false } },
  ]);
});

test("ignores unrelated and unmatched tool lifecycle events", () => {
  const { emit, emitted } = createHarness();

  emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "read-1",
    toolName: "read",
    args: {},
  });
  emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "ask-missing",
    toolName: "ask_user",
    result: {},
    isError: false,
  });

  assert.deepEqual(emitted, []);
});

test("balances concurrent calls and clears active calls on shutdown", () => {
  const { emit, emitted } = createHarness();

  for (const toolCallId of ["ask-1", "ask-2"]) {
    emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId,
      toolName: "ask_user",
      args: {},
    });
  }

  emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask_user",
    args: {},
  });
  emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "ask-1",
    toolName: "ask_user",
    result: {},
    isError: true,
  });
  emit("session_shutdown", {
    type: "session_shutdown",
    reason: "reload",
  });

  assert.deepEqual(
    emitted.map(({ data }) => data),
    [
      { active: true, label: "Waiting for your answer" },
      { active: true, label: "Waiting for your answer" },
      { active: false },
      { active: false },
    ],
  );
});
