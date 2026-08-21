import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-claude-live-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Claude test",
    cwd: process.cwd(),
    model: "haiku",
    reasoningEffort: "off",
    parent,
  };
}

async function claudeAvailable() {
  return Effect.runPromise(claudeBackend.readiness).then(
    (readiness) => readiness.ready,
  );
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test(
  "Claude backend completes a live manager run",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("Reply with exactly: hello claude")),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello claude/i);
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl"));
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude model rejection safely falls back before activity",
  { timeout: 75_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const selected = {
        harness: "claude" as const,
        model: "pi-subagents-intentionally-unavailable-model",
        reasoningEffort: "off" as const,
        runMode: "agent" as const,
      };
      const fallback = {
        harness: "codex" as const,
        model: "gpt-5.6-sol",
        reasoningEffort: "high" as const,
        runMode: "agent" as const,
      };
      const started = await runTool(
        runtime,
        manager.spawn("claude", {
          ...task("Reply with exactly: fallback worked"),
          model: selected.model,
          parent: { ...parent, projectTrusted: true },
          execution: {
            requested: { type: "profile", profile: "worker" },
            selected,
            attempts: [{ ...selected, outcome: "selected" }],
          },
          fallbackCandidates: [fallback],
        }),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 60_000);

      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.backend, "codex");
      assert.match(done?.finalText ?? "", /fallback worked/i);
      assert.deepEqual(
        done?.execution.attempts.map(({ harness, outcome }) => ({
          harness,
          outcome,
        })),
        [
          { harness: "claude", outcome: "unavailable" },
          { harness: "codex", outcome: "selected" },
        ],
      );
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend resumes its native session without replaying tool results",
  { timeout: 90_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const resumeParent: ParentContext = {
      ...parent,
      parentSessionId: "claude-live-resume",
    };
    const firstRuntime = createSubagentRuntime();
    let id: string;
    let nativeSessionId: string;
    let toolResultsBefore: number;
    try {
      const manager = await firstRuntime.runPromise(SubagentManager);
      const started = await runTool(
        firstRuntime,
        manager.spawn("claude", {
          ...task(
            "Run `printf replay-marker` once, then reply with exactly: first claude turn",
          ),
          parent: resumeParent,
        }),
      );
      id = started.id;
      await deadline(runTool(firstRuntime, manager.waitFor([id])), 60_000);
      const done = manager.view.get(id);
      assert.equal(done?.status, "done");
      nativeSessionId = done?.meta.nativeSessionId ?? "";
      assert.ok(nativeSessionId);
      toolResultsBefore =
        done?.transcript.filter((item) => item.kind === "toolResult").length ??
        0;
      assert.ok(toolResultsBefore > 0);
    } finally {
      await firstRuntime.dispose();
    }

    const secondRuntime = createSubagentRuntime();
    try {
      const manager = await secondRuntime.runPromise(SubagentManager);
      await runTool(
        secondRuntime,
        manager.restore(resumeParent.parentSessionId, process.cwd()),
      );
      const resumed = await runTool(
        secondRuntime,
        manager.resume(id!, "Reply with exactly: resumed claude", resumeParent),
      );
      assert.equal(resumed.mode, "native");
      await deadline(runTool(secondRuntime, manager.waitFor([id!])), 60_000);
      const done = manager.view.get(id!);
      assert.equal(done?.status, "done");
      assert.equal(done?.meta.nativeSessionId, nativeSessionId!);
      assert.match(done?.finalText ?? "", /resumed claude/i);
      assert.equal(
        done?.transcript.filter((item) => item.kind === "toolResult").length,
        toolResultsBefore!,
        "resumed history must not replay old tool results as live events",
      );
    } finally {
      await secondRuntime.dispose();
    }
  },
);

test(
  "Claude backend interrupt settles a live run as aborted",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn(
          "claude",
          task(
            "Write a detailed 10,000-word essay about the history of computing.",
          ),
        ),
      );

      // Wait for streamed output so cancellation definitely lands mid-run and
      // exercises the SDK's normal interrupt receipt/result path.
      const streamDeadline = Date.now() + 15_000;
      while (
        manager.view.get(started.id)?.status === "running" &&
        !manager.view.get(started.id)?.liveAssistant?.text &&
        Date.now() < streamDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(manager.view.get(started.id)?.status, "running");
      assert.ok(manager.view.get(started.id)?.liveAssistant?.text);

      const report = await deadline(
        runTool(runtime, manager.cancel([started.id])),
        20_000,
      );

      assert.equal(report[0]?.cancelled, true);
      assert.equal(manager.view.get(started.id)?.status, "cancelled");
      assert.equal(
        manager.view.get(started.id)?.errorText,
        "Run was cancelled",
      );
    } finally {
      await runtime.dispose();
    }
  },
);
