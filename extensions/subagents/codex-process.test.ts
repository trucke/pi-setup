import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import test from "node:test";
import { terminateChild } from "./src/backends/codex.ts";

const READINESS_TIMEOUT_MS = 2_000;

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForChildPid = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = READINESS_TIMEOUT_MS,
) =>
  new Promise<number>((resolve, reject) => {
    let output = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (result: { pid: number } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("pid" in result) resolve(result.pid);
      else reject(result.error);
    };
    const onData = (chunk: string) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const pid = Number.parseInt(output.slice(0, newline).trim(), 10);
      if (Number.isInteger(pid)) finish({ pid });
      else finish({ error: new Error(`Invalid child PID: ${output.trim()}`) });
    };
    const onError = (error: Error) => finish({ error });
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({
        error: new Error(
          `Leader closed before reporting its child PID (code=${code}, signal=${signal})`,
        ),
      });
    const timer = setTimeout(
      () =>
        finish({
          error: new Error(
            "Timed out waiting for leader to report its child PID",
          ),
        }),
      timeoutMs,
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
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
      'child.stdout.once("data", () => console.log(child.pid));',
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
