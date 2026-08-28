import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  registerResearchTool,
  CODEX_OUTPUT_SCHEMA,
  CODEX_TIMEOUT_MS,
  parseResearchOutput,
  runCodexResearch,
  type ResearchResult,
} from "./research.ts";

type Exec = Pick<ExtensionAPI, "exec">["exec"];

function makeExecutor(exec: Exec) {
  return { exec };
}

function lastMessagePath(args: string[]) {
  const path = args[args.indexOf("--output-last-message") + 1];
  assert.ok(path, "codex args must include --output-last-message");
  return path;
}

/** Executor that behaves like a successful codex run writing structured output. */
function successfulExecutor(
  output: unknown,
  onExec?: (args: string[]) => void,
) {
  return makeExecutor(async (command, args) => {
    assert.equal(command, "codex");
    onExec?.(args);
    await writeFile(lastMessagePath(args), JSON.stringify(output), "utf8");
    return { stdout: "", stderr: "", code: 0, killed: false };
  });
}

test("registers web-research with bounded source parameters", () => {
  const tools: Array<{
    name: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown> };
  }> = [];
  const pi = {
    on() {},
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  registerResearchTool(pi);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web-research"],
  );
  assert.match(tools[0].description ?? "", /up to 10 minutes/);
  const parameters = tools[0].parameters?.properties ?? {};
  assert.deepEqual(Object.keys(parameters), ["query", "maxSources"]);
  assert.equal((parameters.query as { minLength?: number }).minLength, 1);
  const maxSources = parameters.maxSources as {
    type?: string;
    maximum?: number;
  };
  assert.equal(maxSources.type, "integer");
  assert.equal(maxSources.maximum, 10);
});

test("invokes codex with an ephemeral, read-only, search-enabled session", async () => {
  let seen: { args: string[]; options: ExecOptions | undefined } | undefined;
  const executor = makeExecutor(async (command, args, options) => {
    seen = { args, options };
    await writeFile(
      lastMessagePath(args),
      JSON.stringify({
        answer: "ok",
        sources: [{ title: "Source", url: "https://example.com/" }],
      }),
      "utf8",
    );
    return { stdout: "", stderr: "", code: 0, killed: false };
  });

  await runCodexResearch(executor, { query: "test question" });

  assert.ok(seen);
  const { args, options } = seen;
  for (const flag of ["exec", "--ephemeral", "--skip-git-repo-check"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  // Root `web_search` override: `tools.web_search=true` resolves to null in
  // codex-cli 0.147.0 and would not force live search.
  assert.equal(args[args.indexOf("--config") + 1], 'web_search="live"');
  assert.equal(options?.timeout, CODEX_TIMEOUT_MS);

  const workDir = args[args.indexOf("--cd") + 1];
  assert.equal(options?.cwd, workDir);

  const prompt = args.at(-1) ?? "";
  assert.match(prompt, /test question/);
  assert.match(prompt, /untrusted/);
  assert.match(prompt, /at most 5 sources/);
  assert.match(prompt, /web search/i);
  assert.match(prompt, /Do not inspect local files/);
});

test("returns rendered markdown with sources and analysis metadata", async () => {
  const executor = successfulExecutor({
    answer: "TypeScript 7 shipped.",
    sources: [
      { title: "Release notes", url: "https://example.com/ts7" },
      { title: "Coverage", url: "https://news.example.com/article" },
    ],
  });

  const result = await runCodexResearch(executor, {
    query: "typescript 7",
    maxSources: 3,
  });

  const text = result.content[0];
  assert.equal(text.type, "text");
  assert.match(text.text, /TypeScript 7 shipped\./);
  assert.match(
    text.text,
    /Sources:\n1\. Release notes — https:\/\/example.com\/ts7/,
  );

  assert.equal(result.details.provider, "codex");
  assert.equal(result.details.success, true);
  assert.equal(result.details.sourceCount, 2);
  assert.ok(result.details.durationMs >= 0);
  assert.deepEqual(result.details.sources[1], {
    title: "Coverage",
    url: "https://news.example.com/article",
  });
});

test("validates sources: http(s) only, deduplicated, capped, titled", () => {
  const research: ResearchResult = parseResearchOutput(
    JSON.stringify({
      answer: "answer",
      sources: [
        { title: "A", url: "https://example.com/a" },
        { title: "A again", url: "https://example.com/a" },
        { title: "Bad scheme", url: "ftp://example.com/b" },
        { title: "Not a URL", url: "nope" },
        { title: "", url: "https://example.com/untitled" },
        { title: "C", url: "http://example.com/c" },
        { title: "D", url: "https://example.com/d" },
      ],
    }),
    3,
  );

  assert.deepEqual(research.sources, [
    { title: "A", url: "https://example.com/a" },
    { title: "example.com", url: "https://example.com/untitled" },
    { title: "C", url: "http://example.com/c" },
  ]);
});

test("rejects malformed output", async () => {
  assert.throws(() => parseResearchOutput("not json", 5), /malformed/);
  assert.throws(
    () => parseResearchOutput(JSON.stringify({ sources: [] }), 5),
    /missing answer or sources/,
  );
  assert.throws(
    () => parseResearchOutput(JSON.stringify({ answer: "a" }), 5),
    /missing answer or sources/,
  );

  const noOutputFile = makeExecutor(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  }));
  await assert.rejects(
    runCodexResearch(noOutputFile, { query: "q" }),
    /no structured output file/,
  );
});

test("rejects results without at least one valid http(s) source", () => {
  assert.throws(
    () => parseResearchOutput(JSON.stringify({ answer: "a", sources: [] }), 5),
    /no valid http\(s\) sources/,
  );
  assert.throws(
    () =>
      parseResearchOutput(
        JSON.stringify({
          answer: "a",
          sources: [
            { title: "Bad scheme", url: "ftp://example.com/a" },
            { title: "Not a URL", url: "nope" },
          ],
        }),
        5,
      ),
    /no valid http\(s\) sources/,
  );
  assert.equal(
    (CODEX_OUTPUT_SCHEMA.properties.sources as { minItems?: number }).minItems,
    1,
  );
});

test("rejects a blank query before spawning codex", async () => {
  const executor = makeExecutor(async () => {
    assert.fail("codex must not be spawned for a blank query");
  });

  await assert.rejects(
    runCodexResearch(executor, { query: "   \n\t " }),
    /non-empty query/,
  );
});

test("strips terminal control sequences from rendered strings", async () => {
  const executor = successfulExecutor({
    answer: "safe \u001b]0;owned\u0007answer\u001b[2Jline",
    sources: [
      {
        title: "Evil\u001b[31m red\u0007\ntitle",
        url: "https://example.com/a",
      },
    ],
  });

  const result = await runCodexResearch(executor, {
    query: "\u001b[1mquery\u009b2J",
  });

  assert.equal(result.details.sources[0].title, "Evil red title");
  const text = result.content[0];
  assert.equal(text.type, "text");
  assert.match(text.text, /safe answerline/);
  assert.doesNotMatch(text.text, /[\u001b\u0007\u009b]/);
});

test("reports timeout when codex is killed by the exec timeout", async () => {
  const executor = makeExecutor(async () => ({
    stdout: "",
    stderr: "",
    code: 1,
    killed: true,
  }));

  await assert.rejects(
    runCodexResearch(executor, { query: "q" }),
    /timed out after 10 minutes/,
  );
});

test("reports cancellation when the abort signal fires", async () => {
  const controller = new AbortController();
  const executor = makeExecutor(async (_command, _args, options) => {
    controller.abort();
    assert.equal(options?.signal?.aborted, true);
    return { stdout: "", stderr: "", code: 1, killed: true };
  });

  await assert.rejects(
    runCodexResearch(executor, { query: "q" }, controller.signal),
    /cancelled/,
  );
});

test("distinguishes missing executable, auth, quota, and process failures", async () => {
  const failing = (result: ExecResult) => makeExecutor(async () => result);

  await assert.rejects(
    runCodexResearch(
      makeExecutor(async () => {
        throw new Error("spawn codex ENOENT");
      }),
      { query: "q" },
    ),
    /Install the `codex` CLI/,
  );
  await assert.rejects(
    runCodexResearch(
      failing({ stdout: "", stderr: "", code: 1, killed: false }),
      { query: "q" },
    ),
    /Install the `codex` CLI/,
  );
  await assert.rejects(
    runCodexResearch(
      failing({
        stdout: "",
        stderr: "401 Unauthorized: not logged in",
        code: 1,
        killed: false,
      }),
      { query: "q" },
    ),
    /codex login/,
  );
  await assert.rejects(
    runCodexResearch(
      failing({
        stdout: "",
        stderr: "You've hit your usage limit",
        code: 1,
        killed: false,
      }),
      { query: "q" },
    ),
    /usage limit/,
  );
  await assert.rejects(
    runCodexResearch(
      failing({
        stdout: "",
        stderr: "stream disconnected",
        code: 3,
        killed: false,
      }),
      { query: "q" },
    ),
    /failed \(exit 3\): stream disconnected/,
  );
});

test("cleans up its temporary session directory", async () => {
  let workDir = "";
  const executor = successfulExecutor(
    {
      answer: "ok",
      sources: [{ title: "Source", url: "https://example.com/" }],
    },
    (args) => {
      workDir = args[args.indexOf("--cd") + 1];
    },
  );

  await runCodexResearch(executor, { query: "q" });

  await assert.rejects(access(workDir));
});

test("cleans up the session directory when codex fails", async () => {
  let workDir = "";
  const executor = makeExecutor(async (_command, args) => {
    workDir = args[args.indexOf("--cd") + 1];
    return { stdout: "", stderr: "broken pipe", code: 3, killed: false };
  });

  await assert.rejects(
    runCodexResearch(executor, { query: "q" }),
    /failed \(exit 3\)/,
  );
  assert.ok(workDir);
  await assert.rejects(access(workDir));
});

test("cleans up the session directory when the tool call is cancelled", async () => {
  const controller = new AbortController();
  let workDir = "";
  const executor = makeExecutor(async (_command, args, options) => {
    workDir = args[args.indexOf("--cd") + 1];
    controller.abort();
    return new Promise<ExecResult>((resolve) => {
      const finish = () =>
        resolve({ stdout: "", stderr: "", code: 1, killed: true });
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish);
    });
  });

  await assert.rejects(
    runCodexResearch(executor, { query: "q" }, controller.signal),
    /cancelled/,
  );
  assert.ok(workDir);
  await assert.rejects(access(workDir));
});

// Consumes ChatGPT subscription quota; run explicitly with
// pnpm test:live:research
test(
  "live codex research",
  { skip: !process.env.CODEX_RESEARCH_LIVE },
  async () => {
    const executor = makeExecutor(
      (command, args, options) =>
        new Promise<ExecResult>((resolve) => {
          const child = spawn(command, args, {
            cwd: options?.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => (stdout += String(data)));
          child.stderr.on("data", (data) => (stderr += String(data)));
          child.on("close", (code) =>
            resolve({ stdout, stderr, code: code ?? 1, killed: false }),
          );
        }),
    );

    const result = await runCodexResearch(executor, {
      query: "What is the current stable version of Node.js?",
      maxSources: 2,
    });

    assert.equal(result.details.success, true);
    assert.ok(result.details.sourceCount >= 1);
  },
);
