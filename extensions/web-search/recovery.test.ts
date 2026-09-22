import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
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
import { createRecoveryQueue, offerReport, recoverFetch } from "./recovery.ts";
import { reviewText, TextPreview, type PreviewContext } from "./preview.ts";
import {
  buildReport,
  REPORT_TITLE,
  submitReport,
  validateReproduction,
} from "./report.ts";

const failure = Object.assign(
  new FetchError(
    "SECRET https://original.example/token",
    "network",
    undefined,
    "ECONNRESET",
  ),
  {
    stack: "SECRET /home/user",
    cause: "SECRET",
    headers: { cookie: "SECRET" },
  },
);
const reproduction = "https://8.8.8.8/repro";
const signal = () => new AbortController().signal;
type Options = Parameters<typeof recoverFetch<string>>[0];

function dialogs(
  choose = (_title: string, choices: string[]): string | undefined =>
    choices[0],
) {
  const titles: string[] = [];
  const notices: string[] = [];
  const ctx: Options["ctx"] = {
    hasUI: true,
    mode: "rpc",
    ui: {
      select: async (title, choices) => {
        titles.push(title);
        assert.equal(choices[0], "No");
        return choose(title, choices);
      },
      input: async (_title, prefill) => {
        assert.equal(prefill, undefined);
        return reproduction;
      },
      notify: (text) => {
        notices.push(text);
      },
      custom: async () => {
        throw new Error("RPC must not open a TUI");
      },
    },
  };
  return { ctx, titles, notices };
}

function recovery(overrides: Partial<Options> = {}) {
  const ui = dialogs();
  const calls = { hosted: 0, reports: 0 };
  const options: Options = {
    url: "https://original.example/token",
    timeout: 5000,
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
    report: async () => {
      calls.reports++;
    },
    ...overrides,
  };
  return { run: () => recoverFetch(options), calls, ui };
}

test("local success stays local; recovery requires fresh consent and preserves the fetch outcome", async () => {
  const local = recovery({ local: async () => "local content" });
  assert.equal(await local.run(), "local content");
  assert.equal(local.ui.titles.length, 0);
  assert.deepEqual(local.calls, { hosted: 0, reports: 0 });

  const declined = recovery();
  await assert.rejects(declined.run(), (error) => error === failure);
  assert.deepEqual(declined.calls, { hosted: 0, reports: 1 });

  const approved = dialogs((_title, choices) => choices[1]);
  const recovered = recovery({
    ctx: approved.ctx,
    report: async () => {
      throw new Error("SECRET gh failure");
    },
  });
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
  assert.equal(failed.calls.reports, 1);
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
    assert.deepEqual(f.calls, { hosted: 0, reports: 0 });
    assert.equal(f.ui.titles.length, 0);
  }
  const controller = new AbortController();
  const ui = dialogs((_title, choices) => {
    controller.abort();
    return choices[1];
  });
  const cancelled = recovery({ ctx: ui.ctx, signal: controller.signal });
  await assert.rejects(cancelled.run());
  assert.deepEqual(cancelled.calls, { hosted: 0, reports: 0 });

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
    assert.deepEqual(f.calls, { hosted: 0, reports: 1 });
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

test("only the reviewed, sanitized report is submitted, with separate publication consent", async () => {
  for (const outcome of ["decline", "publish", "failure"] as const) {
    const ui = dialogs((_title, choices) =>
      outcome === "decline" && choices[1] === "I certify and publish"
        ? "No"
        : choices[1],
    );
    let calls = 0;
    let path = "";
    const body = buildReport(reproduction, failure, 5000);
    await offerReport(ui.ctx, failure, 5000, signal(), {
      validate: validateReproduction,
      submit: (url, error, timeout, abort) =>
        submitReport(
          url,
          error,
          timeout,
          abort,
          async (command, args, options) => {
            calls++;
            assert.equal(command, "gh");
            assert.deepEqual(args.slice(0, 7), [
              "issue",
              "create",
              "--repo",
              "https://github.com/trucke/pi-setup",
              "--title",
              REPORT_TITLE,
              "--body-file",
            ]);
            path = args[7];
            assert.equal(await readFile(path, "utf8"), body);
            assert.equal((await stat(path)).mode & 0o777, 0o600);
            assert.equal(options.signal, abort);
            assert.equal(options.timeout, 30_000);
            if (outcome === "failure") throw new Error("SECRET stderr");
          },
        ),
    });
    assert.equal(calls, outcome === "decline" ? 0 : 1);
    if (path) await assert.rejects(stat(path));
    assert.ok(
      ui.titles.includes(`Exact preview:\nTitle: ${REPORT_TITLE}\n\n${body}`),
    );
    assert.doesNotMatch(
      ui.titles.join("\n") + ui.notices.join("\n"),
      /SECRET|original.example|\/home\/user|cookie/,
    );
    assert.match(body, /ECONNRESET/);
    assert.match(body, /UA=pi-web-fetch\/1/);
    if (outcome === "failure")
      assert.match(ui.notices.join(""), /may already exist/);
  }
  await assert.rejects(
    submitReport(reproduction, failure, 5000, AbortSignal.abort(), async () =>
      assert.fail("must not submit"),
    ),
  );
});

test("report URLs must be public and exclude sensitive components or injected formatting", async () => {
  const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
  for (const url of [
    "https://user:secret@example.com/",
    "https://example.com/?token=secret",
    "https://example.com/#secret",
    "http://127.0.0.1/",
    "https://example.com/```",
    "https://example.com/\nSECRET",
  ])
    await assert.rejects(validateReproduction(url, signal(), publicDns), url);
  await assert.rejects(
    validateReproduction("https://example.com", signal(), async () => [
      ...(await publicDns()),
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

test("the report preview keeps a fitting request whole and scrolls when space is limited", () => {
  const body = buildReport(reproduction, failure, 5000);
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const view = new TextPreview(body, tui, theme, keys, () => {});
  const request = `web-fetch ${JSON.stringify({ url: reproduction, timeout: 5000 })}`;
  assert.ok(view.render(100).some((row) => row.trimEnd() === request));
  tui.terminal.rows = 12;
  const narrow = view.render(40);
  assert.ok(
    narrow.length <= 10 && narrow.every((row) => visibleWidth(row) <= 40),
  );
  view.handleInput("\x1b[F");
  assert.match(view.render(40).join("\n"), /Runtime:/);
  tui.terminal.rows = 30;
  assert.ok(view.render(100).some((row) => row.trimEnd() === request));
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
      "report",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
