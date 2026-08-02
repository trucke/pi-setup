import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUser, {
  type AskUserInput,
  MAX_QUESTIONS,
  normalizeQuestions,
} from "./index.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type TestComponent = {
  handleInput(data: string): void;
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
  execute(
    toolCallId: string,
    params: AskUserInput,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: TestContext,
  ): Promise<ToolResult>;
};

function registeredTool() {
  let tool: TestTool | undefined;
  const pi = {
    registerTool(value: unknown) {
      tool = value as TestTool;
    },
  } as unknown as ExtensionAPI;

  askUser(pi);
  assert.ok(tool);
  return tool;
}

test("normalizes legacy single-question input", () => {
  assert.deepEqual(
    normalizeQuestions({
      question: "Choose one",
      options: [{ label: "A" }, { label: "B" }],
    }),
    [
      {
        label: "Question",
        question: "Choose one",
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
  );
});

test("normalizes batched questions with contextual and fallback labels", () => {
  assert.deepEqual(
    normalizeQuestions({
      questions: [
        {
          label: " Scope ",
          question: "Choose scope",
          options: [{ label: "Small" }, { label: "Large" }],
        },
        {
          question: "Choose priority",
          options: [{ label: "Low" }, { label: "High" }],
        },
      ],
    }),
    [
      {
        label: "Scope",
        question: "Choose scope",
        options: [{ label: "Small" }, { label: "Large" }],
      },
      {
        label: "Q2",
        question: "Choose priority",
        options: [{ label: "Low" }, { label: "High" }],
      },
    ],
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
  assert.deepEqual(
    (result.details as { answers: unknown[]; cancelled: boolean }).answers,
    [
      {
        questionIndex: 0,
        label: "Scope",
        question: "Choose scope",
        options: ["Small", "Large"],
        answer: "Small",
        wasCustom: false,
        index: 1,
      },
      {
        questionIndex: 1,
        label: "Priority",
        question: "Choose priority",
        options: ["Low", "High"],
        answer: "High",
        wasCustom: false,
        index: 2,
      },
    ],
  );
  assert.equal(
    (result.details as { answers: unknown[]; cancelled: boolean }).cancelled,
    false,
  );
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
