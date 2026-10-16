/**
 * Release check with the real Pi executable (`pnpm test:cli`; PI_BIN selects the binary).
 * It stages this package with runtime dependencies only, as `pi install` does, loads it through
 * its manifest and drives a local mock CPA. Pi's compiled binary resolves extension imports
 * differently from Node, so this is the check that catches imports Pi does not provide.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startMockCpa } from "./mock-cpa.ts";

type Json = { readonly [key: string]: unknown };
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repository = path.resolve(import.meta.dirname, "../..");
// pnpm puts node_modules/.bin first, where the dev dependency provides Pi's Node CLI. This
// check is about the installed executable, so those entries are skipped.
const searchPath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => !entry.includes(`node_modules${path.sep}.bin`))
  .join(path.delimiter);
const pi =
  process.env.PI_BIN ??
  spawnSync("which", ["pi"], {
    encoding: "utf8",
    env: { PATH: searchPath },
  }).stdout.trim();
const available =
  pi !== "" && spawnSync(pi, ["--version"], { encoding: "utf8" }).status === 0;

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      // Pi's print mode reads piped stdin until EOF, so stdin must not stay open.
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("error", reject);
      child.on("close", (status) => {
        clearTimeout(timer);
        if (status === null)
          stderr += `\n${command} ${args.join(" ")} timed out`;
        resolve({ status, stdout, stderr });
      });
    },
  );
}

async function stagePackage(): Promise<string> {
  const stage = await mkdtemp(path.join(tmpdir(), "cpa-release-"));
  const packed = await run("pnpm", ["pack", "--pack-destination", stage], {
    cwd: repository,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [tarball] = (await readdir(stage)).filter((file) =>
    file.endsWith(".tgz"),
  );
  assert.ok(tarball);
  const extracted = await run("tar", ["xzf", tarball], { cwd: stage });
  assert.equal(extracted.status, 0, extracted.stderr);
  const root = path.join(stage, "package");
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    await cp(path.join(repository, file), path.join(root, file));
  }
  const installed = await run(
    "pnpm",
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: root },
  );
  assert.equal(installed.status, 0, installed.stderr);
  // Pi supplies its SDK to extensions; a runtime-only install has no copy of it.
  assert.equal(
    existsSync(path.join(root, "node_modules/@earendil-works")),
    false,
  );
  return root;
}

test(
  "the staged package works under the real Pi executable",
  { skip: !available && `${pi} not found` },
  async (t) => {
    t.diagnostic(`pi executable: ${realpathSync(pi)}`);
    const root = await stagePackage();
    const work = await mkdtemp(path.join(tmpdir(), "cpa-release-work-"));
    t.after(async () => {
      await rm(path.dirname(root), { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    });
    const agentDir = path.join(work, "agent");
    const cwd = path.join(work, "project");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(cwd, "note.txt"), "fïrst line 🌍\nsecond line\n");

    const mock = await startMockCpa({
      apiKey: "release-key",
      models: [
        { id: "gpt-6.1-sol", owned_by: "openai" },
        { id: "claude-opus-5-5", owned_by: "anthropic" },
        { id: "go/claude-haiku-5-5" },
      ],
      reply: (items) => {
        const last = items.at(-1);
        if (isJson(last) && last.type === "function_call_output")
          return { text: `read ok: ${String(last.output).split("\n")[0]}` };
        const asked = JSON.stringify(last);
        if (asked.includes("read note")) {
          // Optional read arguments arrive as null, as strict-mode models send them.
          return {
            toolCall: {
              name: "read",
              arguments: JSON.stringify({
                path: "note.txt",
                offset: null,
                limit: null,
              }),
            },
          };
        }
        return { text: "plain answer ✓" };
      },
    });
    t.after(() => mock.close());
    await writeFile(
      path.join(agentDir, "cliproxyapi.json"),
      JSON.stringify({ baseUrl: `${mock.root}/v1`, provider: "cpa-release" }),
    );
    // Only what Pi needs: inherited settings such as PI_CLIPROXYAPI_CONFIG or PI_OFFLINE could
    // point this at a real proxy or change first-use behavior.
    const home = path.join(work, "home");
    await mkdir(home, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: searchPath,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
      PI_CODING_AGENT_DIR: agentDir,
      CLIPROXYAPI_API_KEY: "release-key",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    const piRun = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      run(pi, ["-ne", "-e", root, ...args], { cwd, env: { ...env, ...extra } });

    // First use with an empty agent dir discovers the catalog before model selection.
    const listed = await piRun(["--list-models", "cpa-release"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /cpa-release\s+claude-opus-5-5/);
    assert.match(listed.stdout, /cpa-release\s+gpt-6\.1-sol/);
    assert.doesNotMatch(listed.stdout, /go\/claude/);

    const chat = await piRun([
      "-p",
      "--model",
      "cpa-release/gpt-6.1-sol",
      "read note.txt",
      "thanks",
      "/proxy status",
    ]);
    assert.equal(chat.status, 0, chat.stderr);
    assert.match(chat.stdout, /plain answer ✓/);
    assert.match(
      chat.stderr,
      /3 WebSocket requests \(2 delta, 1 full, 1 connections\), 0 via SSE/,
    );
    assert.doesNotMatch(chat.stderr, /\[bun\] Warning/);
    assert.deepEqual(
      mock.requests.map((request) => [
        request.transport,
        request.connection,
        request.delta,
      ]),
      [
        ["websocket", 1, false],
        ["websocket", 1, true],
        ["websocket", 1, true],
      ],
    );
    const toolOutput = mock.requests[1]?.merged.at(-1);
    assert.ok(
      isJson(toolOutput) && String(toolOutput.output).includes("fïrst line 🌍"),
      JSON.stringify(toolOutput),
    );

    // Offline start from the cached catalog; Claude goes to /v1/messages on the CPA root.
    const offline = await piRun(
      ["-p", "--model", "cpa-release/claude-opus-5-5", "hello"],
      { PI_OFFLINE: "1" },
    );
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /plain answer ✓/);
    assert.equal(mock.requests.at(-1)?.path, "/v1/messages");

    // Negative control: a deep pi-ai import, which an earlier version used, must fail this check.
    const deep = path.join(root, "extensions/cliproxyapi-provider-deep");
    await cp(path.join(root, "extensions/cliproxyapi-provider"), deep, {
      recursive: true,
    });
    const provider = path.join(deep, "src/provider.ts");
    const source = await readFile(provider, "utf8");
    const deepSource = source.replace(
      'import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";',
      'import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";',
    );
    assert.notEqual(deepSource, source);
    await writeFile(provider, deepSource);
    // Print mode reports extension load errors; --list-models does not.
    const broken = await run(
      pi,
      [
        "-ne",
        "-e",
        path.join(deep, "index.ts"),
        "-p",
        "--model",
        "cpa-release/gpt-6.1-sol",
        "hello",
      ],
      { cwd, env },
    );
    assert.notEqual(broken.status, 0);
    assert.match(
      broken.stdout + broken.stderr,
      /Failed to load extension.*anthropic-messages\.lazy/,
    );
  },
);
