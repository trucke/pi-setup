import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createToolCallTimeoutGuard,
  runWithToolCallTimeout,
  ToolCallTimeoutError,
} from "./tool-call-timeout.ts";

test("a hung tool call fails clearly and receives an abort signal", async () => {
  let executionSignal: AbortSignal | undefined;

  await assert.rejects(
    runWithToolCallTimeout("hung_fixture", 10, undefined, (signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    }),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallTimeoutError, true);
      assert.equal(
        error instanceof Error ? error.message : "",
        'Tool call "hung_fixture" timed out after 10 ms.',
      );
      return true;
    },
  );

  assert.equal(executionSignal?.aborted, true);
  assert.equal(executionSignal?.reason instanceof ToolCallTimeoutError, true);
});

test("parent cancellation still stops the timeout wrapper immediately", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled fixture");
  const pending = runWithToolCallTimeout(
    "hung_fixture",
    60_000,
    controller.signal,
    () => new Promise(() => {}),
  );

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("the guard wraps each definition once and can discover later tools", () => {
  const definitions = new Map<string, ToolDefinition>();
  const createDefinition = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
  const first = createDefinition("first");
  definitions.set(first.name, first);
  const registry = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
  };
  const guard = createToolCallTimeoutGuard({ timeoutMs: 10 });

  const firstExecute = first.execute;
  guard.apply(registry);
  const firstWrappedExecute = first.execute;
  assert.notEqual(firstWrappedExecute, firstExecute);

  const second = createDefinition("second");
  const secondExecute = second.execute;
  definitions.set(second.name, second);
  guard.apply(registry);

  assert.equal(first.execute, firstWrappedExecute);
  assert.notEqual(second.execute, secondExecute);
});

test("the guard leaves explicitly exempt tools unchanged", () => {
  const definition = {
    name: "web-research",
    label: "Web Research",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: "done" }],
        details: {},
      };
    },
  } satisfies ToolDefinition;
  const registry = {
    getAllTools: () => [{ name: definition.name }],
    getToolDefinition: () => definition,
  };
  const guard = createToolCallTimeoutGuard({
    timeoutMs: 10,
    exemptToolNames: ["web-research"],
  });
  const execute = definition.execute;

  guard.apply(registry);

  assert.equal(definition.execute, execute);
});
