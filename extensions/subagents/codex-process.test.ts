import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import test from "node:test";
import { terminateChild } from "./src/backends/codex.ts";

const CHILD_PID_MARKER = "child-pid:";

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForChildPid = (child: ChildProcessWithoutNullStreams) =>
  new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for the leader's child PID")),
      2_000,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const match = new RegExp(`${CHILD_PID_MARKER}(\\d+)\\r?\\n`).exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Leader closed before reporting its child PID (code=${code}, signal=${signal})`,
        ),
      );
    });
  });

test(
  "Codex teardown escalates against descendants after the leader exits",
  { skip: process.platform === "win32", timeout: 7_000 },
  async () => {
    const grandchildProgram =
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
    const leaderProgram = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
      `child.stdout.once("data", () => console.log("${CHILD_PID_MARKER}" + child.pid));`,
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", leaderProgram], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });

    try {
      const grandchildPid = await waitForChildPid(child);
      await terminateChild(child, () => exited);
      const deadline = Date.now() + 1_000;
      while (processExists(grandchildPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(processExists(grandchildPid), false);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The process group is already gone on the expected path.
      }
    }
  },
);
