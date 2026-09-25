import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import ui, { markTranscriptRoles } from "./index.ts";
import type { VcsInfoState } from "./vcs/state.ts";

function createFooter(initialVcsState?: VcsInfoState) {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => void
  >();
  let updateVcs: ((state: VcsInfoState) => void) | undefined;
  let footerFactory:
    | ((
        tui: { requestRender(): void },
        theme: Theme,
        data: ReadonlyFooterDataProvider,
      ) => { render(width: number): string[] })
    | undefined;

  const pi = {
    getThinkingLevel() {
      return "medium";
    },
    on(
      name: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void,
    ) {
      handlers.set(name, handler);
    },
    registerMarkdownTransformer() {},
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/project",
    mode: "tui",
    model: {
      provider: "opencode",
      id: "claude-fable-5",
      reasoning: true,
    },
    getContextUsage: () => ({ tokens: 28_600, percent: 38 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { cost: { total: 1.23 } },
          },
        },
      ],
    },
    ui: {
      setHeader() {},
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setTitle() {},
    },
  } as unknown as ExtensionContext;

  ui(pi, (_pi, onStateChange) => {
    updateVcs = onStateChange;
  });
  assert.ok(updateVcs);
  if (initialVcsState) updateVcs(initialVcsState);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.ok(footerFactory);

  const theme = {
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
  const footer = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map<string, string>(),
  } as unknown as ReadonlyFooterDataProvider);

  return {
    setVcs: (state: VcsInfoState) => updateVcs?.(state),
    render: (width: number) => footer.render(width),
  };
}

const vcsState = {
  isRepository: true,
  kind: "jj" as const,
  label: "change-123",
  changedFiles: 3,
  pullRequest: null,
};

test("renders a stable one-line dashboard with VCS and model context", () => {
  // VCS state arrives before session_start and must survive it.
  const footer = createFooter(vcsState);
  const lines = footer.render(160);
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.match(line, /\/tmp\/project/);
  assert.match(line, /jj change-123/);
  assert.match(line, /3 files changed/);
  assert.match(line, /opencode\/claude-fable-5/);
  assert.match(line, /medium · 28\.6K \(38%\) · \$1\.23/);
});

test("marks user and thinking Markdown without breaking fences", () => {
  const context = { isStreaming: false, availableWidth: 80 };
  const mark = (
    markdown: string,
    messageType: "user" | "assistant" | "assistant-thinking",
  ) => markTranscriptRoles(markdown, { ...context, messageType });

  assert.equal(mark("why?", "user"), "› why?");
  assert.equal(mark("```ts\nx\n```", "user"), "›\n```ts\nx\n```");
  assert.equal(mark("hmm", "assistant-thinking"), "_Thinking:_ hmm");
  assert.equal(mark("answer", "assistant"), "answer");
});

test("compacts low-priority fields instead of splitting the line", () => {
  const footer = createFooter();
  footer.setVcs(vcsState);

  const [line = ""] = footer.render(50);
  assert.ok(visibleWidth(line) <= 50);
  assert.match(line, /claude-fable-5/);
  assert.match(line, /med/);
  assert.match(line, /38%/);
  assert.match(line, /\$1\.23/);
  assert.match(line, /\+3/);
  assert.doesNotMatch(line, /\/tmp\/project|opencode\/|change-123/);
});
