import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { persistSnapshot } from "./src/artifacts.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { SpawnTask } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-recovery-test-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

// Both axes (legacy vs current profile name, native vs continuation) are
// covered without running the full matrix.
for (const [profile, mode] of [
  ["reviewer", "continuation"],
  ["review", "native"],
] as const) {
  test(`${profile} retains its recorded role and review scope on ${mode} recovery`, async () => {
    const captured: SpawnTask[] = [];
    const stub = makeStubBackend({
      backend: "claude",
      defaultModelLabel: "stub",
      contextWindow: 1000,
      toolName: "Read",
      cadenceMs: 1,
    });
    const registry = Layer.succeed(
      BackendRegistry,
      new Map([
        [
          "claude",
          {
            ...stub,
            spawn(task: SpawnTask) {
              captured.push(task);
              return stub.spawn(task);
            },
          },
        ],
      ]),
    );
    const createRuntime = () =>
      ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
    const parent = {
      parentCwd: process.cwd(),
      parentSessionId: `${profile}-${mode}`,
      projectTrusted: true,
    };
    const reviewTarget = { type: "commit", sha: "abcdef1234567" } as const;
    let runtime = createRuntime();
    try {
      let manager = await runtime.runPromise(SubagentManager);
      const snap = await runtime.runPromise(
        manager.spawn("claude", {
          prompt: "Original read-only contract. Assess correctness.",
          title: "review",
          cwd: process.cwd(),
          parent,
          reviewTarget,
          profile: "review",
          model: "stub",
        }),
      );
      await runtime.runPromise(manager.waitFor([snap.id]));
      const settled = manager.view.get(snap.id)!;
      assert.equal(settled.execution.attempts, undefined);
      await runtime.dispose();
      if (profile === "reviewer") {
        // Simulate an older on-disk run, not a newly selectable profile.
        persistSnapshot({
          ...settled,
          execution: {
            ...settled.execution,
            requested: { type: "profile", profile },
            attempts: [{ ...settled.execution.selected, outcome: "selected" }],
          },
        });
      }
      runtime = createRuntime();
      manager = await runtime.runPromise(SubagentManager);
      await runtime.runPromise(
        manager.restore(parent.parentSessionId, process.cwd()),
      );
      assert.deepEqual(manager.view.get(snap.id)?.execution.requested, {
        type: "profile",
        profile,
      });
      const recordedExecution = manager.view.get(snap.id)!.execution;
      await runtime.runPromise(
        manager.resume(snap.id, "Continue the review.", parent, mode),
      );
      assert.deepEqual(manager.view.get(snap.id)!.execution, recordedExecution);
      const resumed = captured.at(-1)!;
      assert.deepEqual(resumed.reviewTarget, reviewTarget);
      assert.match(resumed.prompt, /abcdef1234567/);
      assert.match(resumed.prompt, /Do not modify files/);
      if (mode === "continuation")
        assert.match(resumed.prompt, /Original read-only contract/);
      await runtime.runPromise(manager.waitFor([snap.id]));
    } finally {
      await runtime.dispose();
    }
  });
}
