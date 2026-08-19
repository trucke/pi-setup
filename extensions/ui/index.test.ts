import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FIRECRAWL_USAGE_CHANNEL } from "../shared/dashboard-state.ts";
import ui from "./index.ts";
import type { VcsInfoState } from "./vcs/state.ts";

function createFooter(
  statuses: ReadonlyMap<string, string> = new Map(),
  initialVcsState?: VcsInfoState,
) {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => void
  >();
  const eventHandlers = new Map<string, (value: unknown) => void>();
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
    events: {
      on(name: string, handler: (value: unknown) => void) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
      emit(name: string, value: unknown) {
        eventHandlers.get(name)?.(value);
      },
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/project",
    mode: "tui",
    model: {
      provider: "opencode",
      id: "claude-fable-5",
      reasoning: true,
    },
    getContextUsage: () => ({ percent: 38 }),
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
    getExtensionStatuses: () => statuses,
  } as unknown as ReadonlyFooterDataProvider);

  return {
    emit: (name: string, value: unknown) => eventHandlers.get(name)?.(value),
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

test("collects model info and preserves VCS state during startup", () => {
  const footer = createFooter(new Map(), vcsState);

  const [line = ""] = footer.render(160);
  assert.match(line, /opencode\/claude-fable-5/);
  assert.match(line, /jj change-123/);
});

test("renders a stable one-line dashboard with conditional usage", () => {
  const footer = createFooter();
  footer.setVcs(vcsState);

  const beforeFirecrawl = footer.render(160);
  assert.equal(beforeFirecrawl.length, 1);
  assert.match(beforeFirecrawl[0] ?? "", /\/tmp\/project/);
  assert.match(beforeFirecrawl[0] ?? "", /jj change-123/);
  assert.match(beforeFirecrawl[0] ?? "", /3 files changed/);
  assert.match(beforeFirecrawl[0] ?? "", /opencode\/claude-fable-5/);
  assert.match(beforeFirecrawl[0] ?? "", /medium · ctx 38% · \$1\.23/);
  assert.doesNotMatch(beforeFirecrawl[0] ?? "", /FC|tok\/s/);

  footer.emit(FIRECRAWL_USAGE_CHANNEL, {
    creditsUsed: 4,
    budget: 20,
    unlimited: false,
  });
  assert.match(footer.render(160)[0] ?? "", /FC 4\/20 cr/);
});

test("compacts low-priority fields instead of splitting the line", () => {
  const footer = createFooter();
  footer.setVcs(vcsState);
  footer.emit(FIRECRAWL_USAGE_CHANNEL, {
    creditsUsed: 4,
    budget: 20,
    unlimited: false,
  });

  const [line = ""] = footer.render(50);
  assert.ok(visibleWidth(line) <= 50);
  assert.match(line, /claude-fable-5/);
  assert.match(line, /med/);
  assert.match(line, /38%/);
  assert.match(line, /\$1\.23/);
  assert.match(line, /\+3/);
  assert.doesNotMatch(line, /\/tmp\/project|opencode\/|change-123|FC/);
});

test("consolidates extension activity into one transient row", () => {
  const footer = createFooter(
    new Map([
      ["background-terminals", "■ terminal running"],
      ["subagents", "■ 2 agents running"],
    ]),
  );

  const lines = footer.render(120);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "■ terminal running · ■ 2 agents running");
});
