import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { terminateChild } from "./src/backends/codex.ts";

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        const pid = Number.parseInt(output.slice(0, newline).trim(), 10);
        if (Number.isInteger(pid)) resolve(pid);
      });
      child.once("error", reject);
    });

    try {
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
