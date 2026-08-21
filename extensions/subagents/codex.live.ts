import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { Effect } from "effect";
import { codexBackend } from "./src/backends/codex.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-codex-live-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: true,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Codex test",
    cwd: process.cwd(),
    parent,
  };
}

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Codex test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function codexAvailable() {
  return Effect.runPromise(codexBackend.readiness).then(
    (readiness) => readiness.ready,
  );
}

test(
  "Codex backend completes a live manager run",
  { timeout: 75_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn("codex", task("Reply with exactly: hello codex")),
      );

      await deadline(runTool(runtime, manager.waitFor([spawned.id])), 60_000);
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello codex/i);
      assert.equal(done?.meta.backend, "codex");
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Codex asynchronous model rejection falls back before activity",
  { timeout: 75_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const selected = {
        harness: "codex" as const,
        model: "pi-subagents-intentionally-unavailable-model",
        reasoningEffort: "high" as const,
        runMode: "agent" as const,
      };
      const fallback = {
        harness: "claude" as const,
        model: "haiku",
        reasoningEffort: "off" as const,
        runMode: "agent" as const,
      };
      const started = await runTool(
        runtime,
        manager.spawn("codex", {
          ...task("Reply with exactly: codex fallback worked"),
          model: selected.model,
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
      assert.equal(done?.backend, "claude");
      assert.match(done?.finalText ?? "", /codex fallback worked/i);
      assert.deepEqual(
        done?.execution.attempts.map(({ harness, outcome }) => ({
          harness,
          outcome,
        })),
        [
          { harness: "codex", outcome: "unavailable" },
          { harness: "claude", outcome: "selected" },
        ],
      );
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Codex backend resumes its native thread",
  { timeout: 90_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const resumeParent: ParentContext = {
      ...parent,
      parentSessionId: "codex-live-resume",
    };
    const firstRuntime = createSubagentRuntime();
    let id: string;
    let nativeSessionId: string;
    try {
      const manager = await firstRuntime.runPromise(SubagentManager);
      const started = await runTool(
        firstRuntime,
        manager.spawn("codex", {
          ...task("Reply with exactly: first codex turn"),
          parent: resumeParent,
        }),
      );
      id = started.id;
      await deadline(runTool(firstRuntime, manager.waitFor([id])), 60_000);
      const done = manager.view.get(id);
      assert.equal(done?.status, "done");
      nativeSessionId = done?.meta.nativeSessionId ?? "";
      assert.ok(nativeSessionId);
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
        manager.resume(id!, "Reply with exactly: resumed codex", resumeParent),
      );
      assert.equal(resumed.mode, "native");
      await deadline(runTool(secondRuntime, manager.waitFor([id!])), 60_000);
      const done = manager.view.get(id!);
      assert.equal(done?.status, "done");
      assert.equal(done?.meta.nativeSessionId, nativeSessionId!);
      assert.match(done?.finalText ?? "", /resumed codex/i);
    } finally {
      await secondRuntime.dispose();
    }
  },
);

test(
  "Codex backend performs a native uncommitted-changes review",
  { timeout: 120_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-codex-review-"),
    );
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "Pi Live Test"], {
        cwd: repository,
      });
      execFileSync("git", ["config", "user.email", "pi@example.invalid"], {
        cwd: repository,
      });
      fs.writeFileSync(
        path.join(repository, "value.ts"),
        "export const value = 1;\n",
      );
      execFileSync("git", ["add", "value.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
      fs.writeFileSync(
        path.join(repository, "value.ts"),
        "export const value = 2;\n",
      );

      const runtime = createSubagentRuntime();
      try {
        const manager = await runtime.runPromise(SubagentManager);
        const started = await runTool(
          runtime,
          manager.spawn("codex", {
            prompt:
              "Review the uncommitted change and return the review inline. Do not modify files.",
            title: "live Codex review",
            cwd: repository,
            runMode: "review",
            reviewTarget: { type: "uncommittedChanges" },
            parent: {
              parentCwd: repository,
              parentSessionId: "codex-live-review",
              projectTrusted: true,
            },
          }),
        );
        await deadline(runTool(runtime, manager.waitFor([started.id])), 90_000);
        const done = manager.view.get(started.id);
        assert.equal(done?.status, "done");
        assert.ok(done?.finalText.trim());
        assert.deepEqual(done?.reviewTarget, { type: "uncommittedChanges" });
        assert.equal(
          fs.readFileSync(path.join(repository, "value.ts"), "utf8"),
          "export const value = 2;\n",
        );
      } finally {
        await runtime.dispose();
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  },
);

test(
  "Codex backend interrupt settles a live manager run",
  { timeout: 30_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "codex",
          task("Run `sleep 30`, then reply with the word finished."),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await deadline(
        runTool(runtime, manager.cancel([spawned.id])),
        10_000,
      );
      assert.equal(result[0]?.cancelled, true);
      assert.equal(manager.view.get(spawned.id)?.status, "cancelled");
      assert.equal(
        manager.view.get(spawned.id)?.errorText,
        "Run was cancelled",
      );
    } finally {
      await runtime.dispose();
    }
  },
);
