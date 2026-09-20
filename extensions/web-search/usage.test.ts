import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { FIRECRAWL_USAGE_CHANNEL } from "../shared/dashboard-state.ts";
import { registerUsageTracking, usageForEntries } from "./usage.ts";

type Event = {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  details?: unknown;
  isError?: boolean;
};
type Handler = (
  event: Event,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;
function harness(account = false) {
  const handlers = new Map<string, Handler>();
  const published: unknown[] = [];
  const entries: SessionEntry[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry: () => {},
    events: {
      on: () => () => {},
      emit: (name: string, value: unknown) => {
        if (name === FIRECRAWL_USAGE_CHANNEL) published.push(value);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
  const dispatch = registerUsageTracking(pi);
  return {
    published,
    entries,
    dispatch: (id: string) => dispatch(id, account ? "account" : "anonymous"),
    async emit(name: string, event: Event) {
      return handlers.get(name)?.(event, ctx);
    },
  };
}
const call = (id: string, limit = 10): Event => ({
  toolCallId: id,
  toolName: "developer-search",
  input: { limit },
});

test("reserves concurrent attempts, blocks headless overruns and separates anonymous/account usage", async () => {
  for (const account of [false, true]) {
    const h = harness(account);
    for (let i = 0; i < 5; i++)
      assert.equal(await h.emit("tool_call", call(`${i}`, 20)), undefined);
    const blocked = await h.emit("tool_call", call("blocked"));
    assert.equal((blocked as { block: boolean }).block, true);
    await h.emit("tool_result", { ...call("blocked"), isError: true });
    h.dispatch("0");
    const result = await h.emit("tool_result", {
      ...call("0", 20),
      isError: true,
    });
    assert.deepEqual(result, {
      details: {
        developerUsage: { units: 4, auth: account ? "account" : "anonymous" },
      },
    });
    await h.emit("tool_result", call("0", 20));
    assert.deepEqual(h.published.at(-1), {
      unitsUsed: 4,
      anonymousUnits: account ? 0 : 4,
      accountCredits: account ? 4 : 0,
      budget: 20,
      unlimited: false,
    });
  }
});

test("unsubmitted validation failures and cancellation release reservations without usage", async () => {
  const h = harness();
  await h.emit("tool_call", call("invalid", 20));
  assert.equal(
    await h.emit("tool_result", { ...call("invalid"), isError: true }),
    undefined,
  );
  for (let i = 0; i < 5; i++)
    assert.equal(await h.emit("tool_call", call(`${i}`, 20)), undefined);
  assert.deepEqual(h.published.at(-1), {
    unitsUsed: 0,
    anonymousUnits: 0,
    accountCredits: 0,
    budget: 20,
    unlimited: false,
  });
});

test("restores attributed attempts across branches, without guessing old billing", () => {
  const entry = (id: string, details: unknown) =>
    ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "developer-search",
        toolCallId: id,
        details,
      },
    }) as unknown as SessionEntry;
  const entries = [
    entry("a", { developerUsage: { units: 2, auth: "anonymous" } }),
    entry("b", { developerUsage: { units: 4, auth: "account" } }),
    entry("a", { developerUsage: { units: 2, auth: "anonymous" } }),
    entry("legacy", { results: [] }),
  ];
  const state = usageForEntries(entries);
  assert.equal(state.unitsUsed, 6);
  assert.equal(state.anonymousUnits, 2);
  assert.equal(state.accountCredits, 4);
  assert.deepEqual([...state.toolCallIds], ["a", "b"]);
});
