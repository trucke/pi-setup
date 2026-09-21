/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { Effect, Layer, ManagedRuntime, Result, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import {
  activeStubSessionCount,
  makeStubBackend,
} from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import { ConcurrencyLimitError } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const stateDirectory = path.join(
  os.tmpdir(),
  `pi-subagents-manager-test-${process.pid}`,
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

function profileTask(prompt: string): SpawnTask {
  return {
    ...task(prompt),
    profile: "code",
    model: "unavailable-model",
    reasoningEffort: "high",
    runMode: "agent",
  };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.deepEqual(snap.execution.requested, { type: "direct" });

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    // Wait results are deferred first and retracted by the tool after capture;
    // pre-consuming them here would create timeout/interruption races.
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);

    // Durable artifacts hold prompts and output: they must stay private.
    assert.ok(fs.existsSync(done.artifacts.receipt));
    assert.ok(fs.existsSync(done.artifacts.output));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(done.artifacts.receipt).mode & 0o777, 0o600);
      assert.equal(fs.statSync(done.artifacts.directory).mode & 0o777, 0o700);
    }
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("startup rejection reports failure and closes the rejected session", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", profileTask("REJECT:claude unavailable")),
    );
    assert.deepEqual(started.execution, {
      requested: { type: "profile", profile: "code" },
      selected: {
        harness: "claude",
        model: "unavailable-model",
        reasoningEffort: "high",
        runMode: "agent",
      },
    });
    await runTool(runtime, manager.waitFor([started.id]));
    const failed = manager.view.get(started.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.backend, "claude");
    assert.match(failed?.errorText ?? "", /model_not_found/);
    const deadline = Date.now() + 1_000;
    while (activeStubSessionCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(activeStubSessionCount(), 0);
  });
});

test("rejections after activity settle as failures", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT_AFTER_ACTIVITY:claude preserve partial work"),
      ),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    const failed = manager.view.get(started.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.backend, "claude");
    assert.equal(failed?.execution.selected.harness, "claude");
    assert.match(failed?.errorText ?? "", /rejected after activity/);
  });
});

test("cancel just before RunRejected cannot wedge the logical run", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", profileTask("REJECT_RACE:claude cancel race")),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const report = await runTool(runtime, manager.cancel([started.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(started.id)?.status, "cancelled");
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "cancelled", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was cancelled");
  });
});

test("cancellation wins when a backend reports its abort as a failure", async () => {
  const stub = makeStubBackend({
    backend: "pi",
    defaultModelLabel: "test",
    contextWindow: 1000,
    toolName: "bash",
    cadenceMs: 10,
  });
  const backend: SubagentBackend = {
    ...stub,
    spawn: (task) =>
      stub.spawn(task).pipe(
        Effect.map((session) => ({
          ...session,
          events: session.events.pipe(
            Stream.map((event) =>
              event._tag === "RunSettled" &&
              event.outcome._tag === "Interrupted"
                ? {
                    _tag: "RunSettled" as const,
                    outcome: {
                      _tag: "Failed" as const,
                      errorText: "The operation was aborted.",
                      partialText: "Work completed before cancellation",
                    },
                  }
                : event,
            ),
          ),
        })),
      ),
  };
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(Layer.succeed(BackendRegistry, new Map([["pi", backend]]))),
    ),
  );
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    await runTool(runtime, manager.cancel([snap.id]));
    const cancelled = manager.view.get(snap.id)!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.finalText, "Work completed before cancellation");
    assert.deepEqual(cancelled.currentTools, []);
    const saved = JSON.parse(
      fs.readFileSync(cancelled.artifacts.snapshot, "utf8"),
    );
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.finalText, cancelled.finalText);
  } finally {
    await runtime.dispose();
  }
});

test("clean manager shutdown persists active runs as cancelled with partial output", async () => {
  const firstRuntime = createTestRuntime();
  let id: string;
  try {
    const manager = await firstRuntime.runPromise(SubagentManager);
    const snap = await runTool(
      firstRuntime,
      manager.spawn("claude", task("preserve my partial output")),
    );
    id = snap.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(manager.view.get(id)?.status, "running");
  } finally {
    await firstRuntime.dispose();
  }

  const secondRuntime = createTestRuntime();
  try {
    const manager = await secondRuntime.runPromise(SubagentManager);
    await runTool(secondRuntime, manager.restore(undefined, process.cwd()));
    const recovered = manager.view.get(id!);
    assert.equal(recovered?.status, "cancelled");
    assert.equal(
      recovered?.errorText,
      "Parent session ended while the run was active",
    );
    assert.match(recovered?.finalText ?? "", /run Bash/);
  } finally {
    await secondRuntime.dispose();
  }
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    assert.equal(spawns[0]?.origin, "btw");
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      (error) =>
        error instanceof ConcurrencyLimitError &&
        /Max 4 subagents/.test(error.message),
    );
  });
});

test("aborting spawn after session creation closes the unattached scope", async () => {
  await withManager(async (manager, runtime) => {
    const baseline = activeStubSessionCount();
    const controller = new AbortController();
    const spawning = runTool(
      runtime,
      manager.spawn("codex", task("DELAY_RETURN:codex abort acquisition")),
      { signal: controller.signal, interruptMessage: "spawn interrupted" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(spawning, /spawn interrupted/);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      manager.view.list().some((snapshot) => snapshot.status === "running"),
      false,
    );
    assert.equal(activeStubSessionCount(), baseline);
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    const receipt = await runTool(
      runtime,
      manager.send(snap.id, "Second turn"),
    );
    assert.equal(receipt.disposition, "delivered");
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("wait-for-any returns settled ids without cancelling pending runs", async () => {
  await withManager(async (manager, runtime) => {
    const slower = await runTool(
      runtime,
      manager.spawn("claude", task("slower")),
    );
    const faster = await runTool(
      runtime,
      manager.spawn("codex", task("faster")),
    );
    const result = await runTool(
      runtime,
      manager.waitFor([slower.id, faster.id], "any"),
    );
    assert.ok(result.settledIds.length >= 1);
    assert.deepEqual(
      result.settledSnapshots.map((snapshot) => snapshot.id),
      result.settledIds,
    );
    assert.equal(result.timedOut, false);
    for (const id of result.pendingIds) {
      assert.equal(manager.view.get(id)?.status, "running");
    }
    await runTool(runtime, manager.cancel(result.pendingIds));
  });
});

test("wait-for-any never reports a missing run as settled", async () => {
  await withManager(async (manager, runtime) => {
    const result = await runTool(
      runtime,
      manager.waitFor(["sa-deadbeef"], "any", undefined, 1),
    );
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.settledIds, []);
    assert.deepEqual(result.settledSnapshots, []);
  });
});

test(
  "wait timeout leaves the subagent running",
  { timeout: 5_000 },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.spawn("claude", task("keep working")),
      );
      const result = await runTool(
        runtime,
        manager.waitFor([snap.id], "all", undefined, 1),
      );
      assert.equal(result.timedOut, true);
      assert.deepEqual(result.pendingIds, [snap.id]);
      assert.equal(manager.view.get(snap.id)?.status, "running");
      await runTool(runtime, manager.cancel([snap.id]));
    });
  },
);

test("restoring one parent never marks another parent's live run interrupted", async () => {
  const firstRuntime = createTestRuntime();
  const secondRuntime = createTestRuntime();
  try {
    const first = await firstRuntime.runPromise(SubagentManager);
    const live = await runTool(
      firstRuntime,
      first.spawn("codex", {
        ...task("still live"),
        parent: { ...parent, parentSessionId: "live-parent" },
      }),
    );
    const second = await secondRuntime.runPromise(SubagentManager);
    assert.equal(
      await runTool(
        secondRuntime,
        second.restore("different-parent", process.cwd()),
      ),
      0,
    );
    const persisted = JSON.parse(
      fs.readFileSync(live.artifacts.snapshot, "utf8"),
    ) as { status?: string };
    assert.equal(persisted.status, "running");
    await runTool(firstRuntime, first.cancel([live.id]));
  } finally {
    await secondRuntime.dispose();
    await firstRuntime.dispose();
  }
});

test("recovery restoration is scoped to the parent Pi session", async () => {
  const scopedParent: ParentContext = {
    ...parent,
    parentSessionId: "parent-session-a",
  };
  const firstRuntime = createTestRuntime();
  let id: string;
  try {
    const manager = await firstRuntime.runPromise(SubagentManager);
    const snap = await runTool(
      firstRuntime,
      manager.spawn("codex", {
        ...task("scoped recovery"),
        parent: scopedParent,
      }),
    );
    id = snap.id;
    await runTool(firstRuntime, manager.cancel([id]));
  } finally {
    await firstRuntime.dispose();
  }

  const secondRuntime = createTestRuntime();
  try {
    const manager = await secondRuntime.runPromise(SubagentManager);
    assert.equal(
      await runTool(
        secondRuntime,
        manager.restore("parent-session-b", process.cwd()),
      ),
      0,
    );
    assert.equal(manager.view.get(id!), undefined);
    assert.equal(
      await runTool(
        secondRuntime,
        manager.restore("parent-session-a", process.cwd()),
      ),
      1,
    );
    assert.ok(manager.view.get(id!));
  } finally {
    await secondRuntime.dispose();
  }
});

test("an in-flight resume can be aborted or cancelled before attach without leaking its session", async () => {
  const resumeParent: ParentContext = {
    ...parent,
    parentSessionId: "manager-resume-race",
  };
  const firstRuntime = createTestRuntime();
  let recoveredId: string;
  try {
    const manager = await firstRuntime.runPromise(SubagentManager);
    const completed = await runTool(
      firstRuntime,
      manager.spawn("codex", {
        ...task("prepare resumable run"),
        parent: resumeParent,
      }),
    );
    recoveredId = completed.id;
    await runTool(firstRuntime, manager.waitFor([recoveredId]));
  } finally {
    await firstRuntime.dispose();
  }

  const secondRuntime = createTestRuntime();
  try {
    const manager = await secondRuntime.runPromise(SubagentManager);
    await runTool(
      secondRuntime,
      manager.restore(resumeParent.parentSessionId, process.cwd()),
    );
    const resumeSessionBaseline = activeStubSessionCount();
    const controller = new AbortController();
    const abortedResume = runTool(
      secondRuntime,
      manager.resume(
        recoveredId!,
        "DELAY_RETURN:codex abort native resume",
        resumeParent,
      ),
      { signal: controller.signal, interruptMessage: "resume interrupted" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(abortedResume, /resume interrupted/);
    assert.equal(manager.view.get(recoveredId!)?.status, "done");
    assert.equal(activeStubSessionCount(), resumeSessionBaseline);

    const resumePromise = runTool(
      secondRuntime,
      manager.resume(
        recoveredId!,
        "DELAY_SPAWN:codex continue slowly",
        resumeParent,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = await runTool(secondRuntime, manager.cancel([recoveredId!]));
    assert.equal(report[0]?.cancelled, true);
    await assert.rejects(resumePromise, /was cancelled/);
    assert.equal(manager.view.get(recoveredId!)?.status, "done");
  } finally {
    await secondRuntime.dispose();
  }
});

test("settled runs are rediscovered and resume only when requested", async () => {
  const firstRuntime = createTestRuntime();
  let id: string;
  let continuationId: string;
  try {
    const manager = await firstRuntime.runPromise(SubagentManager);
    const snap = await runTool(
      firstRuntime,
      manager.spawn("codex", task("recover me")),
    );
    id = snap.id;
    await runTool(firstRuntime, manager.cancel([id]));

    const completed = await runTool(
      firstRuntime,
      manager.spawn("codex", task("continue from artifact")),
    );
    continuationId = completed.id;
    await runTool(firstRuntime, manager.waitFor([continuationId]));
  } finally {
    await firstRuntime.dispose();
  }

  const secondRuntime = createTestRuntime();
  try {
    const manager = await secondRuntime.runPromise(SubagentManager);
    await runTool(secondRuntime, manager.restore(undefined, process.cwd()));
    const recovered = manager.view.get(id!);
    assert.equal(recovered?.status, "cancelled");
    assert.deepEqual(recovered?.recovery, {
      available: true,
      mode: "native",
    });
    const sendReceipt = await runTool(
      secondRuntime,
      manager.send(id!, "do not auto-restart"),
    );
    assert.equal(sendReceipt.disposition, "unsupported");

    const resumeAttempts = await runTool(
      secondRuntime,
      Effect.forEach(
        ["first", "second"],
        (label) =>
          manager
            .resume(id!, `Finish the recovered task (${label})`, parent)
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(resumeAttempts.filter(Result.isSuccess).length, 1);
    assert.equal(resumeAttempts.filter(Result.isFailure).length, 1);
    const resumed = resumeAttempts.find(Result.isSuccess)?.success;
    assert.equal(resumed?.mode, "native");
    assert.equal(resumed?.snapshot.status, "running");
    await runTool(secondRuntime, manager.waitFor([id!]));
    assert.equal(manager.view.get(id!)?.status, "done");

    const continued = await runTool(
      secondRuntime,
      manager.resume(
        continuationId!,
        "Continue without the native session",
        parent,
        "continuation",
      ),
    );
    assert.equal(continued.mode, "continuation");
    await runTool(secondRuntime, manager.waitFor([continuationId!]));
    assert.equal(manager.view.get(continuationId!)?.status, "done");
  } finally {
    await secondRuntime.dispose();
  }
});
