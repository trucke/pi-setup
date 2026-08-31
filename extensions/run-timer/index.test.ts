import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import runTimer, {
  formatDuration,
  type RunTimerDeps,
  type RunTimerEntryData,
} from "./index.ts";

function createHarness() {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => void
  >();
  const entries: RunTimerEntryData[] = [];
  let renderer:
    | ((
        entry: { data?: RunTimerEntryData },
        options: { expanded: boolean },
        theme: Theme,
      ) => Component)
    | undefined;
  let clock = 0;

  const deps: RunTimerDeps = {
    now: () => clock,
  };

  const pi = {
    on(
      name: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void,
    ) {
      handlers.set(name, handler);
    },
    registerEntryRenderer(customType: string, handler: typeof renderer) {
      assert.equal(customType, "run-timer-result");
      renderer = handler;
    },
    appendEntry(customType: string, data: RunTimerEntryData) {
      assert.equal(customType, "run-timer-result");
      entries.push(data);
    },
  } as unknown as ExtensionAPI;

  const ctx = {} as ExtensionContext;

  runTimer(pi, deps);

  return {
    entries,
    emit: (name: string) => {
      const handler = handlers.get(name);
      assert.ok(handler, `no handler for ${name}`);
      handler({ type: name }, ctx);
    },
    advance: (ms: number) => {
      clock += ms;
    },
    renderEntry: (index: number) => {
      assert.ok(renderer);
      const component = renderer(
        { data: entries[index] },
        { expanded: false },
        {
          fg: (_color: string, text: string) => text,
        } as unknown as Theme,
      );
      return component.render(80).join("\n").trim();
    },
  };
}

test("formats completed durations", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(42_999), "42s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_661_000), "1h 01m 01s");
  assert.equal(formatDuration(-5), "0s");
});

test("appends one completion line when the request settles", () => {
  const harness = createHarness();

  harness.emit("agent_start");
  harness.advance(42_000);
  assert.deepEqual(harness.entries, []);

  harness.emit("agent_settled");
  assert.deepEqual(harness.entries, [{ durationMs: 42_000 }]);
  assert.equal(harness.renderEntry(0), "✓ Worked for 42s");

  harness.advance(10_000);
  assert.deepEqual(harness.entries, [{ durationMs: 42_000 }]);
});

test("keeps one continuous run across repeated agent_start before settle", () => {
  const harness = createHarness();

  harness.emit("agent_start");
  harness.advance(30_000);
  harness.emit("agent_start");
  harness.advance(30_000);
  harness.emit("agent_settled");

  assert.deepEqual(harness.entries, [{ durationMs: 60_000 }]);
  assert.equal(harness.renderEntry(0), "✓ Worked for 1m 00s");
});

test("starts a fresh measurement for the next request", () => {
  const harness = createHarness();

  harness.emit("agent_start");
  harness.advance(5_000);
  harness.emit("agent_settled");

  harness.advance(10_000);
  harness.emit("agent_start");
  harness.advance(2_000);
  harness.emit("agent_settled");

  assert.deepEqual(harness.entries, [
    { durationMs: 5_000 },
    { durationMs: 2_000 },
  ]);
});

test("ignores agent_settled without an active run", () => {
  const harness = createHarness();
  harness.emit("agent_settled");
  assert.deepEqual(harness.entries, []);
});

test("session_shutdown abandons an active measurement", () => {
  const harness = createHarness();

  harness.emit("agent_start");
  harness.advance(3_000);
  harness.emit("session_shutdown");
  assert.deepEqual(harness.entries, []);

  harness.advance(10_000);
  harness.emit("agent_start");
  harness.advance(2_000);
  harness.emit("agent_settled");
  assert.deepEqual(harness.entries, [{ durationMs: 2_000 }]);
});
