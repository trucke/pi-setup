import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionArgs,
  bookmarkArgs,
  logArgs,
  parseBookmarkNames,
  parseLog,
  pushArgs,
} from "./src/model.ts";
import { pushBookmark } from "./src/actions.ts";

const revision = {
  id: "abc123",
  change: "xyz",
  prefix: "x",
  rest: "yz",
  description: 'first\n"quoted"\u0000\u001f\nsecond',
  author: "名前",
  date: "2026-10-08",
  bookmarks: ["feature"],
  working: true,
  empty: false,
  conflict: true,
  immutable: false,
  signed: true,
};

test("graph rows attach to revisions without parsing descriptions as graph or records", () => {
  const entries = parseLog(
    `@  \0${JSON.stringify(revision)}\n│ ╲\n○ │ \0${JSON.stringify({ ...revision, id: "def456", description: "" })}\n├─╯\n`,
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    revision,
    graph: "@  ",
    continuation: ["│ ╲"],
  });
  assert.deepEqual(entries[1]?.continuation, ["├─╯"]);
  assert.equal(entries[1]?.revision.description, "");
  assert.deepEqual(parseLog(""), []);
});

test("malformed and truncated records are errors rather than actionable partial history", () => {
  assert.throws(() => parseLog('@ \0{"id":"abc"}\n'), /Invalid jj/);
  assert.throws(() => parseLog('@ \0{"id":'));
  assert.throws(
    () =>
      parseLog(`@ \0${JSON.stringify(revision)}\n[command output truncated]\n`),
    /too large/,
  );
});

test("commands preserve literal descriptions, names and default revset", () => {
  assert.ok(!logArgs(undefined).includes("-r"));
  assert.deepEqual(logArgs("all()").slice(0, 5), [
    "log",
    "-r",
    "all()",
    "--limit",
    "500",
  ]);
  assert.deepEqual(actionArgs("describe", "abc", ""), [
    "describe",
    "-r",
    "abc",
    "-m",
    "",
  ]);
  assert.deepEqual(actionArgs("describe", "abc", "$(touch nope)\nnext"), [
    "describe",
    "-r",
    "abc",
    "-m",
    "$(touch nope)\nnext",
  ]);
  for (const action of ["sign", "unsign", "abandon"] as const)
    assert.deepEqual(actionArgs(action, "abc"), [action, "-r", "abc"]);
  for (const action of ["new", "edit"] as const)
    assert.deepEqual(actionArgs(action, "abc"), [action, "abc"]);
  assert.deepEqual(actionArgs("squash", "abc"), [
    "squash",
    "-r",
    "abc",
    "--use-destination-message",
  ]);
  assert.deepEqual(bookmarkArgs("--strange", "abc"), [
    "bookmark",
    "set",
    "-r",
    "abc",
    "--",
    "--strange",
  ]);
  assert.ok(bookmarkArgs("main", "abc", true).includes("--allow-backwards"));
  assert.deepEqual(pushArgs("topic*", true), [
    "git",
    "push",
    "-b",
    "exact:topic*",
    "--dry-run",
  ]);
  assert.deepEqual(parseBookmarkNames('"a"\n"b"\n"a"\n'), ["a", "b"]);
});

test("push never runs without an accepted successful dry run", async () => {
  for (const confirm of [false, true]) {
    const calls: string[][] = [];
    let shown = "";
    const pushed = await pushBookmark(
      "feature",
      async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "Add bookmark feature" };
      },
      async (output) => {
        shown = output;
        return confirm;
      },
    );
    assert.equal(shown, "Add bookmark feature");
    assert.equal(pushed, confirm);
    assert.deepEqual(calls, [
      pushArgs("feature", true),
      ...(confirm ? [pushArgs("feature", false)] : []),
    ]);
  }
  let asked = false;
  await assert.rejects(
    pushBookmark(
      "feature",
      async () => ({ code: 1, stdout: "", stderr: "denied" }),
      async () => {
        asked = true;
        return true;
      },
    ),
    /denied/,
  );
  assert.equal(asked, false);
});
