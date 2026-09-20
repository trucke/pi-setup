import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { registerSpawnTools } from "./src/spawn.ts";
import { EXECUTION_PROFILES } from "./src/profiles.ts";

function setup() {
  const tools: ToolDefinition[] = [];
  const requests: Parameters<Parameters<typeof registerSpawnTools>[1]>[0][] =
    [];
  const ctx = { cwd: "/trusted/repo" } as ExtensionContext;
  const signal = new AbortController().signal;
  registerSpawnTools(
    {
      registerTool(tool: ToolDefinition) {
        tools.push(tool);
      },
    } as ExtensionAPI,
    async (request, receivedSignal, receivedContext) => {
      assert.equal(receivedSignal, signal);
      assert.equal(receivedContext, ctx);
      requests.push(request);
      return {
        content: [{ type: "text", text: "spawned" }],
        details: { id: "sa-test" },
      };
    },
  );
  return {
    tools,
    requests,
    async call(name: string, args: unknown) {
      const tool = tools.find((tool) => tool.name === name)!;
      const prepared = tool.prepareArguments
        ? await tool.prepareArguments(args)
        : args;
      assert.equal(
        Value.Check(tool.parameters, prepared),
        true,
        JSON.stringify([...Value.Errors(tool.parameters, prepared)]),
      );
      return tool.execute("test", prepared, signal, undefined, ctx);
    },
  };
}

test("Claude evaluation reaches spawning without a profile or fabricated review target", async () => {
  const { call, requests } = setup();
  const prompt =
    "Compare pi-web-access with our web-search extension. Read-only; report evidence and recommendations.";
  const result = await call("subagent-spawn-direct", {
    name: "Claude evaluation",
    harness: "claude",
    prompt,
  });
  assert.deepEqual(result.details, { id: "sa-test" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, prompt);
  assert.equal(requests[0].profile, undefined);
  assert.equal(requests[0].reviewTarget, undefined);
  assert.deepEqual(requests[0].selected, {
    harness: "claude",
    model: undefined,
    reasoningEffort: undefined,
    runMode: "agent",
  });
});

test("explicit nulls preserve defaults when transports require all properties", async () => {
  const { call, requests } = setup();
  await call("subagent-spawn-direct", {
    name: "Claude evaluation",
    prompt: "Read-only evaluation.",
    harness: "claude",
    workingDir: null,
    model: null,
    reasoningEffort: null,
  });
  assert.equal(requests[0].workingDir, undefined);
  assert.deepEqual(requests[0].selected, {
    harness: "claude",
    model: undefined,
    reasoningEffort: undefined,
    runMode: "agent",
  });
  for (const profile of ["scout", "review"]) {
    await call("subagent-spawn", {
      name: "design evaluation",
      prompt: "Evaluate architecture, not a Git diff.",
      profile,
      workingDir: null,
      reviewTarget: null,
    });
    assert.equal(requests.at(-1)?.reviewTarget, undefined);
    assert.equal(requests.at(-1)?.workingDir, undefined);
  }
});

test("direct spawning preserves explicit settings for every harness", async () => {
  const { call, requests } = setup();
  for (const [harness, model] of [
    ["pi", "provider/model"],
    ["claude", "opus"],
    ["codex", "gpt-6-astra"],
  ]) {
    await call("subagent-spawn-direct", {
      name: "evaluation",
      prompt: "Read only.",
      harness,
      model,
      reasoningEffort: "high",
      workingDir: "/trusted/repo",
    });
    assert.deepEqual(requests.at(-1)?.selected, {
      harness,
      model,
      reasoningEffort: "high",
      runMode: "agent",
    });
    assert.equal(requests.at(-1)?.workingDir, "/trusted/repo");
  }
});

test("profiles keep pinned execution and role instructions; review scope is explicit", async () => {
  const { call, requests } = setup();
  for (const profile of Object.keys(
    EXECUTION_PROFILES,
  ) as (keyof typeof EXECUTION_PROFILES)[]) {
    await call("subagent-spawn", {
      name: "task",
      prompt: "Evaluate this design.",
      profile,
    });
    assert.deepEqual(
      requests.at(-1)?.selected,
      EXECUTION_PROFILES[profile].execution,
    );
    assert.equal(requests.at(-1)?.profile, profile);
    assert.ok(requests.at(-1)?.prompt.includes("Evaluate this design."));
    assert.notEqual(requests.at(-1)?.prompt, "Evaluate this design.");
    assert.equal(requests.at(-1)?.reviewTarget, undefined);
  }
  await call("subagent-spawn", {
    name: "code review",
    prompt: "Report findings.",
    profile: "review",
    reviewTarget: { type: "baseBranch", branch: "main" },
  });
  assert.deepEqual(requests.at(-1)?.reviewTarget, {
    type: "baseBranch",
    branch: "main",
  });
  await assert.rejects(
    call("subagent-spawn", {
      name: "research",
      prompt: "Investigate.",
      profile: "research",
      reviewTarget: { type: "uncommittedChanges" },
    }),
    /omit reviewTarget/,
  );
});

test("schemas reject the captured mixed-mode failure and require an explicit selector", () => {
  const { tools } = setup();
  const captured = {
    prompt: "Evaluate pi-web-access.",
    name: "Claude evaluation",
    profile: "review",
    harness: "claude",
    model: "opus",
    reasoningEffort: "high",
    workingDir: "/trusted/repo",
    reviewTarget: {
      type: "uncommittedChanges",
      branch: "",
      sha: "",
      number: 1,
    },
  };
  for (const tool of tools) {
    assert.equal(Value.Check(tool.parameters, captured), false);
    assert.equal(
      Value.Check(tool.parameters, { name: "task", prompt: "Investigate." }),
      false,
    );
  }
});
