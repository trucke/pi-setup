import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { compactCodemodeRenderer } from "./codemode.ts";

type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderResult>[3];
type Result = Parameters<RenderResult>[0];

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function builtInRenderers() {
  const reused: (Component | undefined)[] = [];
  const renderers: ToolRenderers = {
    renderCall(_args, _theme, context) {
      reused.push(context.lastComponent);
      return new Text("full script", 0, 0);
    },
    renderResult(_result, _options, _theme, context) {
      reused.push(context.lastComponent);
      return new Text("full calls and output", 0, 0);
    },
  };
  return { renderers, reused };
}

/** Mirrors Pi's tool row: render call then result, then draw both. */
function createRow(builtIn: ToolRenderers) {
  const renderers = compactCodemodeRenderer("codemode", () => builtIn);
  assert.ok(renderers?.renderCall && renderers.renderResult);
  const { renderCall, renderResult } = renderers;
  const state = {};
  let callComponent: Component | undefined;
  let resultComponent: Component | undefined;

  return (
    result: Result,
    {
      expanded = false,
      isPartial = false,
      isError = false,
      durationMs,
    }: Partial<
      Pick<RenderContext, "expanded" | "isPartial" | "isError" | "durationMs">
    > = {},
  ) => {
    const args = { code: "return 1" };
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
    resultComponent = renderResult(
      result,
      { expanded, isPartial },
      theme,
      context(resultComponent),
    );
    return [...callComponent.render(80), ...resultComponent.render(80)]
      .map((line) => line.trimEnd())
      .filter(Boolean);
  };
}

function calls(...statuses: string[]) {
  return statuses.map((status, index) => ({
    id: `call-1/${index}`,
    name: "read",
    args: "{}",
    status,
  }));
}

test("collapses codemode to one updating summary line", () => {
  const render = createRow(builtInRenderers().renderers);

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
        content: [{ type: "text", text: "large script output" }],
        details: { calls: calls("ok", "ok", "ok", "ok", "ok") },
      },
      { durationMs: 12 },
    ),
    ["codemode · 5 calls · ✓ · 12ms"],
  );
});

test("summarizes failures and model costs", () => {
  const render = createRow(builtInRenderers().renderers);
  const [first, second] = calls("ok", "error");
  assert.ok(first && second);

  assert.deepEqual(
    render(
      {
        content: [{ type: "text", text: "Script failed" }],
        details: { calls: [{ ...first, cost: 0.0012 }, second] },
      },
      { isError: true, durationMs: 1_500 },
    ),
    ["codemode · 2 calls, 1 failed · ✗ · 1.5s · $0.0012"],
  );
});

test("expanded rows use Pi's renderer without reusing compact components", () => {
  const { renderers, reused } = builtInRenderers();
  const render = createRow(renderers);
  const result = { content: [], details: { calls: calls("ok") } };

  render(result);
  assert.deepEqual(render(result, { expanded: true }), [
    "full script",
    "full calls and output",
  ]);
  render(result, { expanded: true });

  assert.equal(reused[0], undefined);
  assert.equal(reused[1], undefined);
  assert.ok(reused[2] instanceof Text);
  assert.ok(reused[3] instanceof Text);
  assert.equal(
    compactCodemodeRenderer("read", () => renderers),
    renderers,
  );
});
