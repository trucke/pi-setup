import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { FIRECRAWL_USAGE_CHANNEL } from "../shared/dashboard-state.ts";
import uiCustomization from "./index.ts";

test("renders Firecrawl session credits in the dashboard usage line", () => {
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: ExtensionContext) => void
  >();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  let footerFactory:
    | ((
        tui: { requestRender(): void },
        theme: Theme,
        data: ReadonlyFooterDataProvider,
      ) => { render(width: number): string[] })
    | undefined;

  const pi = {
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
    ui: {
      setHeader() {},
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setTitle() {},
    },
  } as unknown as ExtensionContext;

  uiCustomization(pi);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  sessionStart({ type: "session_start", reason: "startup" }, ctx);

  eventHandlers.get(FIRECRAWL_USAGE_CHANNEL)?.({
    creditsUsed: 4,
    budget: 20,
  });
  assert.ok(footerFactory);

  const theme = {
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
  const footer = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map(),
  } as unknown as ReadonlyFooterDataProvider);

  assert.match(footer.render(120)[1] ?? "", /\$0\.00 · FC 4\/20 cr · — tok\/s/);
});
