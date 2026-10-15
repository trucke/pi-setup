import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager as AppKeys,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { FetchError } from "../shared/fetch-error.ts";
import { createRecoveryQueue, recoverFetch } from "./recovery.ts";
import { reviewText, TextPreview, type PreviewContext } from "./preview.ts";

const failure = new FetchError(
  "Local fetch failed",
  "network",
  undefined,
  "ECONNRESET",
);
const signal = () => new AbortController().signal;
type Options = Parameters<typeof recoverFetch<string>>[0];

function dialogs(
  choose = (_title: string, choices: string[]): string | undefined =>
    choices[0],
) {
  const titles: string[] = [];
  const ctx: Options["ctx"] = {
    hasUI: true,
    mode: "rpc",
    ui: {
      select: async (title, choices) => {
        titles.push(title);
        assert.equal(choices[0], "No");
        return choose(title, choices);
      },
      custom: async () => {
        throw new Error("RPC must not open a TUI");
      },
    },
  };
  return { ctx, titles };
}

function recovery(overrides: Partial<Options> = {}) {
  const ui = dialogs();
  const calls = { hosted: 0 };
  const options: Options = {
    pi: { events: createEventBus() },
    url: "https://original.example/token",
    signal: signal(),
    ctx: ui.ctx,
    queue: createRecoveryQueue(),
    local: async () => {
      throw failure;
    },
    hosted: async () => {
      calls.hosted++;
      return "hosted content";
    },
    ...overrides,
  };
  return { run: () => recoverFetch(options), calls, ui };
}

test("local success stays local; recovery requires fresh consent and preserves the fetch outcome", async () => {
  const local = recovery({ local: async () => "local content" });
  assert.equal(await local.run(), "local content");
  assert.equal(local.ui.titles.length, 0);
  assert.equal(local.calls.hosted, 0);

  const declined = recovery();
  await assert.rejects(declined.run(), (error) => error === failure);
  assert.equal(declined.calls.hosted, 0);
  assert.equal(declined.ui.titles.length, 1);

  const approved = dialogs((_title, choices) => choices[1]);
  const recovered = recovery({ ctx: approved.ctx });
  assert.equal(await recovered.run(), "hosted content");
  assert.equal(await recovered.run(), "hosted content");
  assert.equal(approved.titles.length, 2);
  assert.match(approved.titles[0], /Exa.*Firecrawl.*THIS request/);

  const failed = recovery({
    ctx: approved.ctx,
    hosted: async () => {
      throw new Error("SECRET provider");
    },
  });
  await assert.rejects(failed.run(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Local attempt/);
    assert.doesNotMatch(error.message, /SECRET provider/);
    return true;
  });
  assert.equal(approved.titles.length, 3);
});

test("recovery reports blocked only while consent and URL review dialogs are open", async () => {
  for (const mode of ["rpc", "tui"] as const) {
    const pi = { events: createEventBus() };
    let blocked = false;
    const states: boolean[] = [];
    pi.events.on("herdr:blocked", (data) => {
      blocked = (data as { active: boolean }).active;
      states.push(blocked);
    });
    const ui = dialogs();
    let dialogsOpened = 0;
    const opened = () => {
      dialogsOpened++;
      assert.equal(
        blocked,
        true,
        "Herdr must be blocked before showing a dialog",
      );
    };
    const ctx: Options["ctx"] = {
      ...ui.ctx,
      mode,
      ui: {
        select: async (_title, choices) => {
          opened();
          return choices[1];
        },
        custom: (factory) =>
          new Promise((resolve, reject) => {
            opened();
            Promise.resolve(
              factory(
                { terminal: { rows: 30 }, requestRender() {} } as TUI,
                theme as Theme,
                keys as AppKeys,
                resolve,
              ),
            )
              .then((component) => component.handleInput?.("\r"))
              .catch(reject);
          }),
      },
    };
    assert.equal(
      await recovery({
        pi,
        ctx,
        url: `https://original.example/${"a".repeat(200)}`,
        hosted: async () => {
          assert.equal(
            blocked,
            false,
            "hosted fetching is working, not blocked",
          );
          return "hosted content";
        },
      }).run(),
      "hosted content",
    );
    assert.equal(dialogsOpened, 2);
    assert.deepEqual(states, [true, false, true, false]);
    assert.equal(blocked, false);
  }
});

test("failed and cancelled recovery dialogs clear the blocked state without granting consent", async () => {
  for (const outcome of ["failure", "cancel"] as const) {
    const pi = { events: createEventBus() };
    const states: boolean[] = [];
    pi.events.on("herdr:blocked", (data) => {
      states.push((data as { active: boolean }).active);
    });
    const controller = new AbortController();
    const ui = dialogs();
    const fetch = recovery({
      pi,
      signal: controller.signal,
      ctx: {
        ...ui.ctx,
        ui: {
          ...ui.ctx.ui,
          select: async () => {
            assert.deepEqual(states, [true]);
            if (outcome === "cancel") controller.abort();
            throw new Error("dialog closed");
          },
        },
      },
    });
    await assert.rejects(fetch.run(), (error) => error === failure);
    assert.equal(fetch.calls.hosted, 0);
    assert.deepEqual(states, [true, false]);
  }
});

test("headless, unsafe and cancelled requests cannot authorize external work", async () => {
  for (const overrides of [
    { ctx: { ...dialogs().ctx, hasUI: false } },
    { signal: AbortSignal.abort() },
    ...(["unsafe", "invalid", "cancelled"] as const).map((category) => ({
      local: async () => {
        throw new FetchError("blocked", category);
      },
    })),
  ]) {
    const f = recovery(overrides);
    await assert.rejects(f.run());
    assert.equal(f.calls.hosted, 0);
    assert.equal(f.ui.titles.length, 0);
  }
  const controller = new AbortController();
  const ui = dialogs((_title, choices) => {
    controller.abort();
    return choices[1];
  });
  const cancelled = recovery({ ctx: ui.ctx, signal: controller.signal });
  await assert.rejects(cancelled.run());
  assert.equal(cancelled.calls.hosted, 0);

  for (const error of [
    new FetchError("auth", "http", 403),
    new FetchError("unknown", "unknown"),
  ]) {
    const f = recovery({
      local: async () => {
        throw error;
      },
    });
    await assert.rejects(f.run());
    assert.equal(f.ui.titles.length, 0);
    assert.equal(f.calls.hosted, 0);
  }
});

test("parallel recovery dialogs serialize and skip cancelled requests", async () => {
  const queue = createRecoveryQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const first = queue(signal(), async () => {
    order.push("start");
    await gate;
    order.push("end");
  });
  const controller = new AbortController();
  const second = queue(controller.signal, async () => {
    order.push("cancelled");
  });
  controller.abort();
  await assert.rejects(second);
  const third = queue(signal(), async () => {
    order.push("third");
  });
  release();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["start", "end", "third"]);
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

test("the URL preview keeps fitting text whole and scrolls when space is limited", () => {
  const text = JSON.stringify(
    `https://example.com/${"path/".repeat(40)}finish`,
  );
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const view = new TextPreview(text, tui, theme, keys, () => {});
  assert.ok(view.render(240).some((row) => row.trimEnd() === text));
  tui.terminal.rows = 12;
  const narrow = view.render(40);
  assert.ok(
    narrow.length <= 10 && narrow.every((row) => visibleWidth(row) <= 40),
  );
  view.handleInput("\x1b[F");
  assert.match(view.render(40).join("\n"), /finish/);
  tui.terminal.rows = 30;
  assert.ok(view.render(240).some((row) => row.trimEnd() === text));
});

test("cancelling the TUI preview closes it without leaking an abort listener", async () => {
  const controller = new AbortController();
  const custom: PreviewContext["ui"]["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      Promise.resolve(
        factory(
          { terminal: { rows: 30 }, requestRender() {} } as TUI,
          theme as Theme,
          keys as AppKeys,
          resolve,
        ),
      )
        .then(() => controller.abort())
        .catch(reject);
    });
  await assert.rejects(
    reviewText(
      {
        mode: "tui",
        ui: { custom, select: async () => assert.fail("must not paginate") },
      },
      "https://example.com/",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
