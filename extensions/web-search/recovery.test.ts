import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { FetchError } from "../shared/fetch-error.ts";
import { fetchHosted } from "./hosted-fetch.ts";
import { HostedError, providerFailure, withHostedFallback } from "./mcp.ts";
import {
  approveQuotaFallback,
  createRecoveryQueue,
  recoverFetch,
} from "./recovery.ts";

const failure = new FetchError("Local fetch failed", "network");
const signal = () => new AbortController().signal;

function recovery(
  overrides: Partial<Parameters<typeof recoverFetch<string>>[0]> = {},
) {
  const calls = { hosted: 0, notes: 0 };
  return {
    calls,
    run: () =>
      recoverFetch({
        signal: signal(),
        local: async () => {
          throw failure;
        },
        hosted: async () => {
          calls.hosted++;
          return "hosted content";
        },
        note: () => {
          calls.notes++;
        },
        ...overrides,
      }),
  };
}

function approval(choice: string | undefined) {
  const pi = { events: createEventBus() };
  const states: boolean[] = [];
  pi.events.on("herdr:blocked", (data) =>
    states.push((data as { active: boolean }).active),
  );
  const titles: string[] = [];
  const options: Parameters<typeof approveQuotaFallback>[0] = {
    pi,
    signal: signal(),
    queue: createRecoveryQueue(),
    ctx: {
      hasUI: true,
      ui: {
        select: async (title, choices) => {
          assert.equal(states.at(-1), true);
          assert.deepEqual(choices, ["No", "Try Firecrawl"]);
          titles.push(title);
          return choice;
        },
      },
    },
  };
  return { options, states, titles };
}

test("local success stays local; recoverable failures emit one note and automatically recover", async () => {
  const local = recovery({ local: async () => "local content" });
  assert.equal(await local.run(), "local content");
  assert.deepEqual(local.calls, { hosted: 0, notes: 0 });
  const recovered = recovery();
  assert.equal(await recovered.run(), "hosted content");
  assert.deepEqual(recovered.calls, { hosted: 1, notes: 1 });
  const failed = recovery({
    hosted: async () => {
      throw new Error("Firecrawl quota exhausted");
    },
  });
  await assert.rejects(
    failed.run(),
    /Local attempt:.*\nHosted attempt: Firecrawl quota exhausted/,
  );
});

test("unsafe, terminal and cancelled local requests never trigger hosted work", async () => {
  for (const category of [
    "unsafe",
    "invalid",
    "cancelled",
    "unknown",
  ] as const) {
    const f = recovery({
      local: async () => {
        throw new FetchError("blocked", category);
      },
    });
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, { hosted: 0, notes: 0 });
  }
  const cancelled = recovery({ signal: AbortSignal.abort() });
  await assert.rejects(cancelled.run());
  assert.deepEqual(cancelled.calls, { hosted: 0, notes: 0 });
  const auth = recovery({
    local: async () => {
      throw new FetchError("auth", "http", 403);
    },
  });
  await assert.rejects(auth.run());
  assert.deepEqual(auth.calls, { hosted: 0, notes: 0 });
});

test("only an Exa billing failure asks before trying Firecrawl, with fresh approval each time", async () => {
  for (const choice of ["Try Firecrawl", "No", undefined]) {
    const ui = approval(choice);
    const providers: string[] = [];
    const run = () =>
      fetchHosted(
        async ({ provider }) => {
          providers.push(provider);
          assert.equal(ui.states.at(-1) ?? false, false);
          if (provider === "exa")
            throw new HostedError("billing", "quota exhausted");
          return "page";
        },
        { url: "https://example.com" },
        ui.options.signal,
        {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          approveBillingFallback: () => approveQuotaFallback(ui.options),
        },
      );
    if (choice === "Try Firecrawl") {
      assert.equal((await run()).provider, "firecrawl");
      assert.equal((await run()).provider, "firecrawl");
      assert.deepEqual(providers, ["exa", "firecrawl", "exa", "firecrawl"]);
      assert.equal(ui.titles.length, 2);
    } else {
      await assert.rejects(
        run(),
        (error) => error instanceof HostedError && error.kind === "billing",
      );
      assert.deepEqual(providers, ["exa"]);
    }
    assert.equal(ui.states.at(-1), false);
  }
});

test("headless, failed and cancelled quota dialogs never authorize fallback and clear blocked state", async () => {
  const headless = approval("Try Firecrawl");
  headless.options.ctx.hasUI = false;
  assert.equal(await approveQuotaFallback(headless.options), false);
  assert.equal(headless.titles.length, 0);
  for (const outcome of ["failure", "cancel"] as const) {
    const ui = approval("Try Firecrawl");
    const controller = new AbortController();
    ui.options.signal = controller.signal;
    ui.options.ctx.ui.select = async () => {
      if (outcome === "cancel") {
        controller.abort();
        return "Try Firecrawl";
      }
      throw new Error("dialog failed");
    };
    assert.equal(await approveQuotaFallback(ui.options), false);
    assert.deepEqual(ui.states, [true, false]);
  }
});

test("ordinary failures fall back without approval; Firecrawl quota errors stop without another dialog", async () => {
  for (const kind of ["transient", "rate-limit", "unavailable"] as const) {
    const providers: string[] = [];
    let approvals = 0;
    const run = (secondaryFails: boolean) =>
      withHostedFallback(
        async (provider) => {
          providers.push(provider);
          if (provider === "exa")
            throw new HostedError(kind, "temporary failure");
          if (secondaryFails)
            throw new HostedError("billing", "Firecrawl quota exhausted");
          return "page";
        },
        signal(),
        undefined,
        async () => {
          approvals++;
          return true;
        },
      );
    assert.equal((await run(false)).provider, "firecrawl");
    await assert.rejects(run(true), /Firecrawl quota exhausted/);
    assert.deepEqual(providers, ["exa", "firecrawl", "exa", "firecrawl"]);
    assert.equal(approvals, 0);
  }
});

test("parallel quota dialogs serialize and skip cancelled requests", async () => {
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

test("quota exhaustion is distinct from temporary rate limiting", () => {
  for (const message of [
    "Free tier exhausted",
    "Free tier limit reached",
    "Monthly quota exceeded",
    "You have exceeded the free Exa MCP rate limit",
    "Insufficient credits",
  ]) {
    assert.equal(providerFailure(message, 429).kind, "billing", message);
  }
  assert.equal(
    providerFailure("Too many requests, retry later", 429).kind,
    "rate-limit",
  );
});
