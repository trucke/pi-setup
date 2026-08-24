import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import undo, { findLatestUserEntryId } from "./index.ts";

interface TestContext {
  readonly isIdle: () => boolean;
  readonly sessionManager: { getBranch(): SessionEntry[] };
  readonly navigateTree: (
    targetId: string,
    options: { summarize?: boolean },
  ) => Promise<{ cancelled: boolean }>;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

interface RegisteredCommand {
  readonly description: string;
  readonly handler: (args: string, ctx: TestContext) => Promise<void>;
}

function userEntry(id: string, parentId: string | null, content = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content: [], timestamp: 0 },
  } as unknown as SessionEntry;
}

function customEntry(id: string, parentId: string | null) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "fixture",
  } as SessionEntry;
}

function registerUndoCommand() {
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand(name: string, options: unknown) {
      assert.equal(name, "undo");
      command = options as RegisteredCommand;
    },
  } as unknown as ExtensionAPI;

  undo(pi);
  assert.ok(command);
  return command;
}

function createContext(options: {
  entries?: SessionEntry[];
  idle?: boolean;
  cancelled?: boolean;
  error?: Error;
}) {
  const notifications: Array<{
    message: string;
    level: "info" | "warning" | "error";
  }> = [];
  const navigations: Array<{
    targetId: string;
    options: { summarize?: boolean };
  }> = [];

  const context: TestContext = {
    isIdle: () => options.idle ?? true,
    sessionManager: { getBranch: () => options.entries ?? [] },
    async navigateTree(targetId, navigateOptions) {
      navigations.push({ targetId, options: navigateOptions });
      if (options.error) throw options.error;
      return { cancelled: options.cancelled ?? false };
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return { context, notifications, navigations };
}

test("finds the latest user entry on the active branch", () => {
  const entries = [
    userEntry("user-1", null),
    assistantEntry("assistant-1", "user-1"),
    userEntry("user-2", "assistant-1"),
    assistantEntry("assistant-2", "user-2"),
    customEntry("status", "assistant-2"),
  ];

  assert.equal(findLatestUserEntryId(entries), "user-2");
  assert.equal(
    findLatestUserEntryId([assistantEntry("assistant", null)]),
    undefined,
  );
});

test("registers a conversation-only undo command", () => {
  const command = registerUndoCommand();
  assert.match(command.description, /latest user turn/i);
});

test("rewinds to the latest user entry without a summary", async () => {
  const command = registerUndoCommand();
  const { context, navigations, notifications } = createContext({
    entries: [
      userEntry("user-1", null),
      assistantEntry("assistant-1", "user-1"),
      userEntry("user-2", "assistant-1"),
      assistantEntry("assistant-2", "user-2"),
    ],
  });

  await command.handler("", context);

  assert.deepEqual(navigations, [
    { targetId: "user-2", options: { summarize: false } },
  ]);
  assert.deepEqual(notifications, []);
});

test("refuses to queue undo while the agent is active", async () => {
  const command = registerUndoCommand();
  const { context, navigations, notifications } = createContext({
    idle: false,
    entries: [userEntry("user", null)],
  });

  await command.handler("", context);

  assert.deepEqual(navigations, []);
  assert.match(notifications[0]?.message ?? "", /interrupt/i);
  assert.equal(notifications[0]?.level, "warning");
});

test("reports empty history, invalid arguments, cancellation, and failures", async () => {
  const command = registerUndoCommand();

  const empty = createContext({});
  await command.handler("", empty.context);
  assert.match(empty.notifications[0]?.message ?? "", /no user turn/i);

  const invalid = createContext({ entries: [userEntry("user", null)] });
  await command.handler("unexpected", invalid.context);
  assert.match(invalid.notifications[0]?.message ?? "", /Usage: \/undo/);
  assert.deepEqual(invalid.navigations, []);

  const cancelled = createContext({
    entries: [userEntry("user", null)],
    cancelled: true,
  });
  await command.handler("", cancelled.context);
  assert.match(cancelled.notifications[0]?.message ?? "", /cancelled/i);

  const failed = createContext({
    entries: [userEntry("user", null)],
    error: new Error("navigation broke"),
  });
  await command.handler("", failed.context);
  assert.match(failed.notifications[0]?.message ?? "", /navigation broke/);
  assert.equal(failed.notifications[0]?.level, "error");
});
