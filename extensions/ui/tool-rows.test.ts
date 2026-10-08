import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { codemodeRow } from "./codemode.ts";
import { compactToolRows, type ToolResult } from "./tool-rows.ts";

type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderResult>[3];
type RowOptions = Partial<
  Pick<RenderContext, "expanded" | "isPartial" | "isError" | "durationMs">
>;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const resolve = compactToolRows({ codemode: codemodeRow });

function builtInRenderers(callText = "read src/index.ts:1-40") {
  const reused: (Component | undefined)[] = [];
  const renderers: ToolRenderers = {
    renderCall(_args, _theme, context) {
      reused.push(context.lastComponent);
      return new Text(`${callText}\nsecond call line`, 0, 0);
    },
    renderResult(_result, _options, _theme, context) {
      reused.push(context.lastComponent);
      return new Text("full output", 0, 0);
    },
  };
  return { renderers, reused };
}

/** Mirrors Pi's tool row: render call then result, then draw both. */
function createRow(toolName: string, builtIn: ToolRenderers, width = 80) {
  const renderers = resolve(toolName, () => builtIn);
  assert.ok(renderers?.renderCall && renderers.renderResult);
  assert.equal(renderers.renderShell, "self");
  const { renderCall, renderResult } = renderers;
  const state = {};
  let callComponent: Component | undefined;
  let resultComponent: Component | undefined;

  return (
    result: ToolResult | undefined,
    {
      expanded = false,
      isPartial = false,
      isError = false,
      durationMs,
    }: RowOptions = {},
  ) => {
    const args = { path: "src/index.ts" };
    const context = (lastComponent: Component | undefined): RenderContext => ({
      args,
      toolCallId: "call-1",
      invalidate() {},
      lastComponent,
      state,
      cwd: "/tmp/project",
      executionStarted: true,
      argsComplete: true,
      isPartial,
      expanded,
      showImages: false,
      isError,
      durationMs,
      outputPad: 0,
    });
    callComponent = renderCall(args, theme, context(callComponent));
    resultComponent = result
      ? renderResult(
          result,
          { expanded, isPartial },
          theme,
          context(resultComponent),
        )
      : undefined;
    return [
      ...callComponent.render(width),
      ...(resultComponent?.render(width) ?? []),
    ]
      .map((line) => stripTerminalSequences(line).trimEnd())
      .filter(Boolean);
  };
}

const text = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
  details: undefined,
});

test("collapses a tool to its call line, status and duration", () => {
  const render = createRow("read", builtInRenderers().renderers);

  assert.deepEqual(render(undefined, { isPartial: true }), [
    "read src/index.ts:1-40 · …",
  ]);
  assert.deepEqual(render(text("file contents"), { durationMs: 12 }), [
    "read src/index.ts:1-40 · ✓ · 12ms",
  ]);
});

test("shows the last error line on failure", () => {
  const render = createRow("bash", builtInRenderers("$ pnpm test").renderers);

  assert.deepEqual(
    render(text("✖ 1 failing test\n\nCommand exited with code 1\n"), {
      isError: true,
      durationMs: 1_500,
    }),
    ["$ pnpm test · ✗ · 1.5s · Command exited with code 1"],
  );
});

test("truncates a long call line before the status", () => {
  const { renderers } = builtInRenderers(`bash ${"x".repeat(100)}`);
  const render = createRow("bash", renderers, 40);

  const [line] = render(text("ok"), { durationMs: 3 });
  assert.ok(line?.endsWith("… · ✓ · 3ms"), line);
  // The last column stays free for the fullscreen scrollbar.
  assert.equal(line.length, 39);
});

test("tools without a call renderer show their arguments", () => {
  const render = createRow("bg-status", {});

  assert.deepEqual(render(text("running"), { durationMs: 4 }), [
    'bg-status path="src/index.ts" · ✓ · 4ms',
  ]);
  assert.deepEqual(render(text("running"), { expanded: true }), [
    "bg-status",
    "  path: src/index.ts",
    "running",
  ]);
});

function calls(...statuses: string[]) {
  return statuses.map((status, index) => ({
    id: `call-1/${index}`,
    name: "read",
    args: "{}",
    status,
  }));
}

test("summarizes codemode calls, failures and model costs", () => {
  const render = createRow("codemode", builtInRenderers().renderers);
  const [first, second] = calls("ok", "error");
  assert.ok(first && second);

  assert.deepEqual(
    render(
      { content: [], details: { calls: calls("running") } },
      { isPartial: true },
    ),
    ["codemode · 1 call · …"],
  );
  assert.deepEqual(
    render(
      {
        content: [{ type: "text", text: "Script failed" }],
        details: { calls: [{ ...first, cost: 0.0012 }, second] },
      },
      { isError: true, durationMs: 1_500 },
    ),
    ["codemode · 2 calls, 1 failed · ✗ · 1.5s · $0.0012 · Script failed"],
  );
});

test("expanded rows frame Pi's renderers and reuse only their components", () => {
  const { renderers, reused } = builtInRenderers();
  const render = createRow("read", renderers);
  const result = text("file contents");

  render(result);
  assert.deepEqual(render(result, { expanded: true }), [
    "read src/index.ts:1-40",
    "second call line",
    "full output",
  ]);
  render(result, { expanded: true });

  // Collapsed rows render the call too, so its component is reused from the start.
  assert.equal(reused[0], undefined);
  assert.ok(reused[1] instanceof Text);
  assert.equal(reused[2], undefined);
  assert.ok(reused[3] instanceof Text);
  assert.ok(reused[4] instanceof Text);
});

test("tools with their own framing are not framed again", () => {
  const { renderers } = builtInRenderers();
  const selfFramed = resolve("edit", () => ({
    ...renderers,
    renderShell: "self",
  }));
  const call = selfFramed?.renderCall?.({}, theme, {
    args: {},
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp/project",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    durationMs: 5,
    outputPad: 0,
  });
  assert.ok(call instanceof Text);
});
