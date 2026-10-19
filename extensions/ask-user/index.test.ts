import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import askUser, { type AskUserInput } from "./index.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    questions: unknown[];
    answers: Array<{ answer: string; selected?: string[] }>;
    cancelled: boolean;
  };
};

type TestComponent = {
  focused: boolean;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
};

type TestTheme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type TestCustomFactory = (
  tui: { requestRender(): void; terminal: { rows: number; columns: number } },
  theme: TestTheme,
  keybindings: object,
  done: (result: unknown) => void,
) => TestComponent;

type TestContext = {
  mode: ExtensionContext["mode"];
  hasUI: boolean;
  ui?: { custom(factory: TestCustomFactory): Promise<unknown> };
};

type TestTool = {
  execute(
    toolCallId: string,
    params: AskUserInput,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: TestContext,
  ): Promise<ToolResult>;
};

const ENTER = "\r";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const ESC = "\u001b";
const TAB = "\t";
const PAGE_DOWN = "\u001b[6;5~";
const PAGE_UP = "\u001b[5;5~";

const batch: AskUserInput = {
  questions: [
    {
      label: "Scope",
      question: "Choose scope",
      options: [{ label: "Small" }, { label: "Large" }],
    },
    {
      label: "Priority",
      question: "Choose priority",
      options: [{ label: "Low" }, { label: "High" }],
    },
  ],
};

function registeredTool() {
  let tool: TestTool | undefined;
  let activeTools = ["read", "ask-user", "bash"];
  const listeners = new Map<
    string,
    (event: unknown, ctx: TestContext) => void
  >();
  const events: Array<{ name: string; value: unknown }> = [];
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        events.push({ name, value });
      },
    },
    on(name: string, listener: (event: unknown, ctx: TestContext) => void) {
      listeners.set(name, listener);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    registerTool(value: unknown) {
      tool = value as TestTool;
    },
  };

  askUser(pi as unknown as ExtensionAPI);
  assert.ok(tool);
  return { tool, pi, listeners, events };
}

async function openQuestionnaire(
  params: AskUserInput,
  rows = 24,
  signal?: AbortSignal,
) {
  const registered = registeredTool();
  const terminal = { rows, columns: 80 };
  let component: TestComponent | undefined;
  let finished = false;
  let mount!: () => void;
  const mounted = new Promise<void>((resolve) => {
    mount = resolve;
  });
  const result = registered.tool.execute("ask-1", params, signal, undefined, {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory) =>
        new Promise((resolve) => {
          component = factory(
            { requestRender() {}, terminal },
            {
              fg: (_color, text) => text,
              bg: (_color, text) => text,
              bold: (text) => text,
            },
            {},
            (value) => {
              finished = true;
              component?.dispose();
              resolve(value);
            },
          );
          component.focused = true;
          mount();
        }),
    },
  });
  await mounted;
  assert.ok(component);
  const view = component;
  return {
    ...registered,
    result,
    terminal,
    view,
    get finished() {
      return finished;
    },
    input(...keys: string[]) {
      for (const key of keys) view.handleInput(key);
    },
    render(width = terminal.columns) {
      return view.render(width);
    },
  };
}

test("hides the tool without a terminal UI and restores only its own removal", () => {
  const { pi, listeners } = registeredTool();
  const start = listeners.get("session_start");
  const beforeTurn = listeners.get("before_agent_start");
  assert.ok(start);
  assert.ok(beforeTurn);

  for (const mode of ["json", "print", "rpc"] as const) {
    start({}, { mode, hasUI: mode === "rpc" });
    assert.deepEqual(pi.getActiveTools(), ["read", "bash"]);
    beforeTurn({}, { mode, hasUI: false });
    assert.deepEqual(pi.getActiveTools(), ["read", "bash"]);
  }
  beforeTurn({}, { mode: "tui", hasUI: true });
  assert.deepEqual(pi.getActiveTools(), ["read", "bash", "ask-user"]);

  pi.setActiveTools(["read"]);
  beforeTurn({}, { mode: "tui", hasUI: true });
  assert.deepEqual(pi.getActiveTools(), ["read"]);
});

test("returns structured batched question details if called without UI anyway", async () => {
  const result = await registeredTool().tool.execute(
    "ask-1",
    batch,
    undefined,
    undefined,
    { mode: "json", hasUI: false },
  );
  assert.match(result.content[0].text, /questionnaire could not be shown/);
  assert.deepEqual(result.details, {
    questions: [
      { label: "Scope", question: "Choose scope", options: ["Small", "Large"] },
      {
        label: "Priority",
        question: "Choose priority",
        options: ["Low", "High"],
      },
    ],
    answers: [],
    cancelled: true,
  });
});

test("requires every batch question before submitting and preserves single-select results", async () => {
  const run = await openQuestionnaire(batch);
  run.input(ENTER, TAB, ENTER);
  assert.equal(run.finished, false);
  assert.match(run.render().join("\n"), /Priority: Unanswered/);
  run.input(LEFT, DOWN, ENTER, ENTER);

  const result = await run.result;
  assert.equal(
    result.content[0].text,
    [
      "User submitted these answers:",
      "Scope: user selected option 1: Small",
      "Priority: user selected option 2: High",
    ].join("\n"),
  );
  assert.deepEqual(
    result.details.answers.map(({ answer }) => answer),
    ["Small", "High"],
  );
  assert.equal(result.details.cancelled, false);
  assert.deepEqual(run.events, [
    {
      name: "herdr:blocked",
      value: { active: true, label: "Waiting for your answer" },
    },
    { name: "herdr:blocked", value: { active: false } },
  ]);
});

test("multi-select combines checked options and custom text without advancing on a toggle", async () => {
  const run = await openQuestionnaire({
    questions: [{ ...batch.questions[0], multiSelect: true }],
  });
  run.input(" ", DOWN, ENTER, "1");
  assert.equal(run.finished, false);
  assert.match(run.render().join("\n"), /\[ \] 1\. Small/);
  assert.match(run.render().join("\n"), /\[x\] 2\. Large/);
  run.input("3", "Security checks", ENTER);
  assert.equal(run.finished, false);
  run.input(ENTER);

  const result = await run.result;
  assert.equal(
    result.content[0].text,
    'User selected options: "Large"\nUser wrote: Security checks',
  );
  assert.deepEqual(result.details.answers[0], {
    questionIndex: 0,
    label: "Scope",
    question: "Choose scope",
    options: ["Small", "Large"],
    selected: ["Large"],
    answer: "Security checks",
  });
  assert.deepEqual(result.details.questions, [
    {
      label: "Scope",
      question: "Choose scope",
      options: ["Small", "Large"],
      multiSelect: true,
    },
  ]);
});

test("multi-select requires at least one choice or nonblank custom text", async () => {
  const run = await openQuestionnaire({
    questions: [{ ...batch.questions[0], multiSelect: true }],
  });
  run.input(DOWN, DOWN, DOWN, ENTER);
  assert.equal(run.finished, false);
  assert.match(run.render().join("\n"), /Select at least one option/);
  run.input("3", "  ", ENTER, ENTER);
  assert.equal(run.finished, false);
  run.input("3", "Something else", ENTER, ENTER);
  const result = await run.result;
  assert.deepEqual(result.details.answers[0].selected, []);
  assert.equal(result.details.answers[0].answer, "Something else");
});

test("editing a committed multi-select invalidates it until Done is confirmed again", async () => {
  const run = await openQuestionnaire({
    questions: [
      { ...batch.questions[0], multiSelect: true },
      batch.questions[1],
    ],
  });
  run.input("1", DOWN, DOWN, DOWN, ENTER, "1");
  assert.match(run.render().join("\n"), /Scope: Small/);
  run.input(LEFT, LEFT);
  assert.match(run.render().join("\n"), /\[x\] 1\. Small/);
  run.input("1", TAB, TAB, ENTER);
  assert.equal(run.finished, false);
  assert.match(run.render().join("\n"), /Scope: Unanswered/);
  run.input(LEFT, LEFT, "2", DOWN, DOWN, ENTER, TAB, ENTER);
  const result = await run.result;
  assert.deepEqual(result.details.answers[0].selected, ["Large"]);
  assert.match(result.content[0].text, /Scope: User selected options: "Large"/);
});

test("long options scroll inside a bounded view, keeping heading, focus and hints visible after resize", async () => {
  const run = await openQuestionnaire(
    {
      questions: [
        {
          question: "Which checks should run?",
          multiSelect: true,
          options: Array.from({ length: 5 }, (_value, index) => ({
            label: `Check ${index + 1} 🧪`,
            description:
              `Description ${index + 1}. ` +
              "Detailed explanation with wide characters 日本語. ".repeat(20),
          })),
        },
      ],
    },
    24,
  );
  const initial = run.render(50);
  assert.ok(initial.length <= 16);
  assert.match(initial.join("\n"), /Which checks should run/);
  assert.match(initial.join("\n"), /❯ \[ \] 1\. Check 1/);
  assert.match(initial.join("\n"), /↓ more below/);
  assert.match(initial.join("\n"), /Done confirm/);
  run.input(PAGE_DOWN);
  const paged = run.render(50);
  assert.match(paged.join("\n"), /↑/);
  assert.match(paged.join("\n"), /Ctrl\+PgUp\/PgDn scroll/);
  assert.notDeepEqual(paged, initial);
  run.input(PAGE_UP);
  assert.deepEqual(run.render(50), initial);

  run.input(DOWN);
  assert.match(run.render(50).join("\n"), /❯ \[ \] 2\. Check 2/);
  run.terminal.rows = 18;
  const smaller = run.render(32);
  assert.ok(smaller.length <= 12);
  assert.ok(smaller.every((line) => visibleWidth(line) <= 32));
  assert.match(smaller.join("\n"), /❯ \[ \] 2\. Check 2/);
  assert.match(smaller.join("\n"), /Which checks should run/);
  run.input(ESC);
  await run.result;
});

test("custom-answer cursor remains visible with long options, and Esc still returns to options", async () => {
  const run = await openQuestionnaire(
    {
      questions: [
        {
          ...batch.questions[0],
          options: batch.questions[0].options.map((option) => ({
            ...option,
            description: "Context. ".repeat(100),
          })),
        },
      ],
    },
    18,
  );
  run.input("3", "My answer");
  const lines = run.render(40);
  assert.ok(lines.length <= 12);
  assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
  assert.match(lines.join("\n"), /My answer/);
  run.input(ESC);
  assert.equal(run.finished, false);
  run.input("2");
  const result = await run.result;
  assert.equal(result.content[0].text, "User selected option 2: Large");
});

test("aborting an open questionnaire closes it and clears Herdr's blocked status", async () => {
  const controller = new AbortController();
  const run = await openQuestionnaire(batch, 24, controller.signal);
  controller.abort();
  const result = await run.result;
  assert.equal(run.finished, true);
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.answers, []);
  assert.deepEqual(run.events.at(-1), {
    name: "herdr:blocked",
    value: { active: false },
  });
});
