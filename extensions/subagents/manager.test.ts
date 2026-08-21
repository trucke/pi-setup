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
import { Effect, Layer, ManagedRuntime, Result } from "effect";
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
  const selected = {
    harness: "claude" as const,
    model: "unavailable-model",
    reasoningEffort: "high" as const,
    runMode: "agent" as const,
  };
  const fallback = {
    harness: "codex" as const,
    model: "fallback-model",
    reasoningEffort: "high" as const,
    runMode: "agent" as const,
  };
  return {
    ...task(prompt),
    execution: {
      requested: { type: "profile", profile: "worker" },
      selected,
      attempts: [{ ...selected, outcome: "selected" }],
    },
    fallbackCandidates: [fallback],
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
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // Wait results are deferred first and retracted by the tool after capture;
    // pre-consuming them here would create timeout/interruption races.
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
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

test("a typed pre-activity rejection advances the same run to its fallback", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", profileTask("REJECT:claude use fallback")),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    const done = manager.view.get(started.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.backend, "codex");
    assert.equal(done?.execution.selected.harness, "codex");
    assert.deepEqual(
      done?.execution.attempts.map(({ harness, outcome, reason }) => ({
        harness,
        outcome,
        hasReason: Boolean(reason),
      })),
      [
        { harness: "claude", outcome: "unavailable", hasReason: true },
        { harness: "codex", outcome: "selected", hasReason: false },
      ],
    );
    assert.equal(
      done?.transcript.filter((item) => item.kind === "user").length,
      1,
      "the rejected candidate's synthetic user row must not be duplicated",
    );
  });
});

test("rejections after meaningful activity never trigger fallback", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT_AFTER_ACTIVITY:claude do not fallback"),
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

test("all rejected profile candidates produce one failed run with attempt history", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT:claude REJECT:codex exhaust candidates"),
      ),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    const failed = manager.view.get(started.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.errorText ?? "", /No fallback candidate/);
    assert.deepEqual(
      failed?.execution.attempts.map(({ harness, outcome }) => ({
        harness,
        outcome,
      })),
      [
        { harness: "claude", outcome: "unavailable" },
        { harness: "codex", outcome: "unavailable" },
      ],
    );
  });
});

test("direct runs never use an undeclared fallback", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", task("REJECT:claude direct failure")),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    const failed = manager.view.get(started.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.backend, "claude");
    assert.match(failed?.errorText ?? "", /model_not_found/);
  });
});

test("cancel just before RunRejected cannot wedge the logical run", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT_RACE:claude DELAY_SPAWN:codex cancel race"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const report = await runTool(runtime, manager.cancel([started.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(started.id)?.status, "cancelled");
  });
});

test("direct startup rejection honors an earlier cancellation", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", task("REJECT_RACE:claude direct cancel race")),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const report = await runTool(runtime, manager.cancel([started.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(started.id)?.status, "cancelled");
  });
});

test("cancellation during a fallback transition stops the logical run", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT:claude DELAY_SPAWN:codex cancel the transition"),
      ),
    );
    const deadline = Date.now() + 1_000;
    while (
      manager.view.get(started.id)?.lastEvent !== "RunRejected" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(started.id)?.lastEvent, "RunRejected");
    const report = await runTool(runtime, manager.cancel([started.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(started.id)?.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(manager.view.get(started.id)?.backend, "claude");
    assert.equal(manager.view.get(started.id)?.status, "cancelled");
  });
});

test("a fallback transition occupies exactly one concurrency slot", async () => {
  await withManager(async (manager, runtime) => {
    const transitioning = await runTool(
      runtime,
      manager.spawn(
        "claude",
        profileTask("REJECT:claude DELAY_SPAWN:codex count one slot"),
      ),
    );
    const deadline = Date.now() + 1_000;
    while (
      manager.view.get(transitioning.id)?.lastEvent !== "RunRejected" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const others = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3],
        (number) => manager.spawn("codex", task(`parallel ${number}`)),
        { concurrency: "unbounded" },
      ),
    );
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("fifth logical run"))),
      (error) => error instanceof ConcurrencyLimitError,
    );
    await runTool(
      runtime,
      manager.cancel([transitioning.id, ...others.map(({ id }) => id)]),
    );
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

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
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
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
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

test("send receipts distinguish queued backend continuations", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("first turn")),
    );
    const toolDeadline = Date.now() + 2_000;
    while (
      (manager.view.get(snap.id)?.liveTools.length ?? 0) === 0 &&
      Date.now() < toolDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok((manager.view.get(snap.id)?.liveTools.length ?? 0) > 0);
    const receipt = await runTool(
      runtime,
      manager.send(snap.id, "follow-up turn"),
    );
    assert.equal(receipt.disposition, "queued");
    await runTool(runtime, manager.cancel([snap.id]));
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

test("wait returns detached terminal snapshots", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("codex", task("capture terminal receipt")),
    );
    const wait = await runTool(runtime, manager.waitFor([started.id]));
    const receipt = wait.settledSnapshots[0];
    assert.equal(receipt?.status, "done");
    assert.notEqual(receipt, manager.view.get(started.id));

    await runTool(runtime, manager.send(started.id, "start another turn"));
    const deadline = Date.now() + 1_000;
    while (
      manager.view.get(started.id)?.status !== "running" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(started.id)?.status, "running");
    assert.equal(receipt?.status, "done");
    await runTool(runtime, manager.cancel([started.id]));
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

test("snapshots expose factual liveness, usage, and durable artifacts", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("report facts")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.ok(done.lastActivityAt >= done.startedAt);
    assert.equal(done.lastEvent, "RunSettled");
    assert.equal(done.currentTools.length, 0);
    assert.ok((done.usage.inputTokens ?? 0) > 0);
    assert.ok(fs.existsSync(done.artifacts.receipt));
    assert.ok(fs.existsSync(done.artifacts.snapshot));
    assert.ok(fs.existsSync(done.artifacts.transcript));
    assert.ok(fs.existsSync(done.artifacts.output));
    const receipt = JSON.parse(
      fs.readFileSync(done.artifacts.receipt, "utf8"),
    ) as { version?: number; execution?: unknown };
    assert.equal(receipt.version, 1);
    assert.ok(receipt.execution);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(done.artifacts.receipt).mode & 0o777, 0o600);
      assert.equal(fs.statSync(done.artifacts.directory).mode & 0o777, 0o700);
    }
  });
});

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

test("in-flight resume uses one slot and can be cancelled before attach", async () => {
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

    const running = await runTool(
      secondRuntime,
      Effect.forEach([1, 2], (number) =>
        manager.spawn("claude", task(`occupy ${number}`)),
      ),
    );
    const resumePromise = runTool(
      secondRuntime,
      manager.resume(
        recoveredId!,
        "DELAY_SPAWN:codex continue slowly",
        resumeParent,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fourth = await runTool(
      secondRuntime,
      manager.spawn("claude", task("fourth logical run")),
    );
    const report = await runTool(secondRuntime, manager.cancel([recoveredId!]));
    assert.equal(report[0]?.cancelled, true);
    await runTool(secondRuntime, manager.cancel([fourth.id]));
    await assert.rejects(
      runTool(
        secondRuntime,
        manager.resume(
          recoveredId!,
          "competing resume must not steal the claim",
          resumeParent,
        ),
      ),
      /already running or resuming/,
    );
    await assert.rejects(resumePromise, /was cancelled/);
    assert.equal(manager.view.get(recoveredId!)?.status, "done");

    await runTool(
      secondRuntime,
      manager.cancel([...running.map(({ id }) => id), fourth.id]),
    );
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
