import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUser, { type AskUserInput, MAX_QUESTIONS } from "./index.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type TestComponent = {
  handleInput(data: string): void;
  render(width: number): string[];
};

type TestTheme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type TestCustomFactory = (
  tui: { requestRender(): void },
  theme: TestTheme,
  keybindings: object,
  done: (result: unknown) => void,
) => TestComponent;

type TestContext = {
  mode: string;
  ui?: {
    custom(factory: TestCustomFactory): Promise<unknown>;
  };
};

type TestTool = {
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
    anyOf?: unknown;
  };
  prepareArguments?(args: unknown): unknown;
  execute(
    toolCallId: string,
    params: AskUserInput,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: TestContext,
  ): Promise<ToolResult>;
};

function registeredTool(emitted: Array<{ name: string; value: unknown }> = []) {
  let tool: TestTool | undefined;
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        emitted.push({ name, value });
      },
    },
    registerTool(value: unknown) {
      tool = value as TestTool;
    },
  } as unknown as ExtensionAPI;

  askUser(pi);
  assert.ok(tool);
  return tool;
}

test("exposes a root object schema for GLM-compatible tool calling", () => {
  const tool = registeredTool();

  assert.equal(tool.parameters.type, "object");
  assert.ok(tool.parameters.properties?.questions);
  assert.equal(tool.parameters.anyOf, undefined);
});

test("prepares legacy single-question calls for resumed sessions", () => {
  const tool = registeredTool();

  assert.deepEqual(
    tool.prepareArguments?.({
      question: "Choose one",
      options: [{ label: "A" }, { label: "B" }],
    }),
    {
      questions: [
        {
          question: "Choose one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    },
  );
});

test("returns structured batched question details when no UI is available", async () => {
  const result = await registeredTool().execute(
    "ask-1",
    {
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
    },
    undefined,
    undefined,
    { mode: "json" },
  );

  assert.match(result.content[0].text, /questionnaire could not be shown/);
  assert.deepEqual(result.details, {
    questions: [
      {
        label: "Scope",
        question: "Choose scope",
        options: ["Small", "Large"],
      },
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

test("reports the interactive wait to Herdr", async () => {
  const emitted: Array<{ name: string; value: unknown }> = [];

  await registeredTool(emitted).execute(
    "ask-1",
    {
      questions: [
        {
          question: "Choose one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: { custom: async () => null },
    },
  );

  assert.deepEqual(emitted, [
    {
      name: "herdr:blocked",
      value: { active: true, label: "Waiting for your answer" },
    },
    { name: "herdr:blocked", value: { active: false } },
  ]);
});

test("collects a batch through question tabs and the submit tab", async () => {
  const theme: TestTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  const result = await registeredTool().execute(
    "ask-1",
    {
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
    },
    undefined,
    undefined,
    {
      mode: "tui",
      ui: {
        custom: (factory) =>
          new Promise((resolve) => {
            const component = factory(
              { requestRender() {} },
              theme,
              {},
              resolve,
            );
            component.handleInput("\r");
            component.handleInput("\u001b[B");
            component.handleInput("\r");
            component.handleInput("\r");
          }),
      },
    },
  );

  assert.equal(
    result.content[0].text,
    [
      "User submitted these answers:",
      "Scope: user selected option 1: Small",
      "Priority: user selected option 2: High",
    ].join("\n"),
  );
  const details = result.details as {
    answers: Array<{ answer: string }>;
    cancelled: boolean;
  };
  assert.deepEqual(
    details.answers.map(({ answer }) => answer),
    ["Small", "High"],
  );
  assert.equal(details.cancelled, false);
});

test("rejects batches larger than the supported maximum", async () => {
  const questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => ({
    question: `Question ${index + 1}`,
    options: [{ label: "A" }, { label: "B" }],
  }));

  await assert.rejects(
    registeredTool().execute(
      "ask-1",
      { questions } as AskUserInput,
      undefined,
      undefined,
      { mode: "json" },
    ),
    /between 1 and 4 questions/,
  );
});
