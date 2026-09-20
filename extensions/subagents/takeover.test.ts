import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import {
  openSubagentPicker,
  openSubagentTakeover,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("list and takeover show the recorded profile or custom before long titles", async () => {
  let snap: SubagentSnapshot = {
    id: "sa-test",
    origin: "model",
    backend: "pi",
    title: "Long task title ".repeat(20),
    prompt: "",
    cwd: "/repo",
    parentCwd: "/repo",
    status: "done",
    startedAt: 0,
    settledAt: 1000,
    lastActivityAt: 1000,
    lastEvent: "Recovered",
    meta: { backend: "pi", modelLabel: "model" },
    usage: {},
    execution: {
      requested: { type: "profile", profile: "scout" },
      selected: { harness: "pi", runMode: "agent" },
    },
    transcript: [],
    liveTools: [],
    currentTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    artifacts: {
      directory: "",
      receipt: "",
      snapshot: "",
      transcript: "",
      output: "",
    },
    recovery: { available: false },
  };
  const view: SubagentReadModel = {
    list: () => [snap],
    get: () => snap,
    size: () => 1,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestSend() {},
    requestAbort() {},
    setOnSettled() {},
  };
  const tui = { terminal: { rows: 30 }, requestRender() {} } as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const keys = {
    getKeys: () => [],
    matches: (_data: string, binding: string) =>
      binding === "tui.select.cancel",
  } as unknown as KeybindingsManager;
  let expected = "scout";
  let renders = 0;
  const ctx = {
    ui: {
      async custom(
        factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
      ) {
        const component = await factory(tui, theme, keys, () => {});
        try {
          for (const width of [60, 120]) {
            const lines = component.render(width);
            assert.ok(lines.some((line) => line.includes(`[${expected}]`)));
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
          }
          renders++;
        } finally {
          component.handleInput?.("\u001b");
        }
        return null;
      },
    },
  } as unknown as ExtensionCommandContext;
  for (const requested of [
    { type: "profile", profile: "scout" },
    { type: "profile", profile: "historical-reviewer" },
    { type: "direct" },
  ] as const) {
    snap = { ...snap, execution: { ...snap.execution, requested } };
    expected = requested.type === "profile" ? requested.profile : "custom";
    await openSubagentPicker(ctx, view);
    await openSubagentTakeover(ctx, view, snap.id);
  }
  assert.equal(renders, 6);
});
