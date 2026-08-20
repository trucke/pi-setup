import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";
import {
  buildFdArgs,
  buildRgArgs,
  FD_DEFAULT_LIMIT,
  normalizeSearchPath,
} from "./src/args.ts";
import {
  MissingBinaryError,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
} from "./src/binaries.ts";
import { formatCapturedOutput, formatOutput } from "./src/output.ts";
import { executeSearchProcess } from "./src/process.ts";
import { fdParameters, makeBinaryInitializers, rgParameters } from "./index.ts";

// --- argument construction -------------------------------------------------

it("fd args: defaults list everything with the default limit", () => {
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
});

it("fd args: all options are translated and pattern stays behind --", () => {
  const args = buildFdArgs({
    pattern: "-rf",
    path: "@src",
    type: "file",
    extension: ".ts",
    glob: true,
    hidden: true,
    maxDepth: 3,
    limit: 50,
  });
  assert.deepEqual(args, [
    "--color=never",
    "--hidden",
    "--glob",
    "--type",
    "f",
    "--extension",
    "ts",
    "--max-depth",
    "3",
    "--max-results",
    "50",
    "--",
    "-rf",
    "src",
  ]);
});

it("fd args: out-of-range values are clamped", () => {
  const args = buildFdArgs({ maxDepth: 500, limit: 1_000_000 });
  assert.deepEqual(args, [
    "--color=never",
    "--max-depth",
    "64",
    "--max-results",
    "10000",
    "--",
    "",
  ]);
});

it("rg args: defaults use smart-case and safe separators", () => {
  assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--smart-case",
    "--max-count",
    "100",
    "--",
    "--help",
  ]);
});

it("rg args: all options are translated", () => {
  const args = buildRgArgs({
    pattern: "TODO",
    path: "@lib",
    glob: "*.ts",
    fileType: "ts",
    caseSensitive: true,
    fixedStrings: true,
    hidden: true,
    context: 2,
    limit: 10,
  });
  assert.deepEqual(args, [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--case-sensitive",
    "--fixed-strings",
    "--hidden",
    "--context",
    "2",
    "--glob",
    "*.ts",
    "--type",
    "ts",
    "--max-count",
    "10",
    "--",
    "TODO",
    "lib",
  ]);
});

it("rg args: caseSensitive false forces ignore-case", () => {
  const args = buildRgArgs({ pattern: "x", caseSensitive: false });
  assert.isTrue(args.includes("--ignore-case"));
  assert.isFalse(args.includes("--smart-case"));
});

it("public parameter schemas use camelCase", () => {
  assert.deepEqual(Object.keys(fdParameters().properties), [
    "pattern",
    "path",
    "type",
    "extension",
    "glob",
    "hidden",
    "maxDepth",
    "limit",
  ]);
  assert.deepEqual(Object.keys(rgParameters().properties), [
    "pattern",
    "path",
    "glob",
    "fileType",
    "caseSensitive",
    "fixedStrings",
    "hidden",
    "context",
    "limit",
  ]);
});

it("path normalization strips leading @ and expands ~", () => {
  assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
  assert.equal(normalizeSearchPath("~"), homedir());
  assert.equal(normalizeSearchPath("~/projects"), join(homedir(), "projects"));
  assert.equal(normalizeSearchPath(" plain "), "plain");
});

// --- binary resolution -----------------------------------------------------

function makeEnv(available: string[]): BinaryEnv & { probes: string[] } {
  const probes: string[] = [];
  return {
    probes,
    probe: (command) =>
      Effect.sync(() => {
        probes.push(command);
        return available.includes(command);
      }),
  };
}

it.effect("binary resolution: system fd wins", () =>
  Effect.gen(function* () {
    const env = makeEnv(["fd"]);
    const resolved = yield* resolveBinary(TOOL_SPECS.fd, env);

    assert.deepEqual(resolved, {
      tool: "fd",
      command: "fd",
      source: "system",
    });
    assert.deepEqual(env.probes, ["fd"]);
  }),
);

it.effect("binary resolution: fdfind is accepted as a system fd", () =>
  Effect.gen(function* () {
    const env = makeEnv(["fdfind"]);
    const resolved = yield* resolveBinary(TOOL_SPECS.fd, env);

    assert.deepEqual(resolved, {
      tool: "fd",
      command: "fdfind",
      source: "system",
    });
    assert.deepEqual(env.probes, ["fd", "fdfind"]);
  }),
);

it.effect("binary resolution: a missing executable fails clearly", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(resolveBinary(TOOL_SPECS.rg, makeEnv([])));

    assert.instanceOf(error, MissingBinaryError);
    assert.match(error.message, /requires `rg` on PATH/);
    assert.match(error.message, /Install rg and restart Pi/);
  }),
);

it.effect(
  "binary resolution: one missing tool does not disable the other",
  () =>
    Effect.gen(function* () {
      const initializers = makeBinaryInitializers(makeEnv(["rg"]));

      const fdError = yield* Effect.flip(initializers.fd);
      const rg = yield* initializers.rg;

      assert.instanceOf(fdError, MissingBinaryError);
      assert.deepEqual(rg, { tool: "rg", command: "rg", source: "system" });
    }),
);

// --- output truncation -----------------------------------------------------

it.effect("process output is streamed to a complete spill file", () =>
  Effect.gen(function* () {
    const result = yield* executeSearchProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("line\\n".repeat(3000))'],
      cwd: process.cwd(),
      tempPrefix: "pi-search-test-",
    });
    const formatted = formatCapturedOutput(result.output);

    assert.equal(result.code, 0);
    assert.isTrue(formatted.truncated);
    assert.equal(formatted.lineCount, 3000);
    assert.match(formatted.text, /2000 of 3000 lines/);
    assert.isDefined(formatted.fullOutputPath);

    const fs = yield* FileSystem.FileSystem;
    const fullOutput = yield* fs.readFileString(formatted.fullOutputPath);
    assert.equal(fullOutput, "line\n".repeat(3000));
    yield* fs.remove(dirname(formatted.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("output: small results pass through untouched", async () => {
  const formatted = await formatOutput("a.ts\nb.ts\n", {
    tempPrefix: "pi-fd-",
    persistFullOutput: () => Promise.reject(new Error("should not persist")),
  });
  assert.equal(formatted.text, "a.ts\nb.ts");
  assert.equal(formatted.lineCount, 2);
  assert.isFalse(formatted.truncated);
  assert.isUndefined(formatted.fullOutputPath);
});

it("output: oversized results are truncated and persisted", async () => {
  const bigOutput = Array.from({ length: 3000 }, (_, i) => `file-${i}.ts`).join(
    "\n",
  );
  let persisted: string | undefined;
  const formatted = await formatOutput(bigOutput, {
    tempPrefix: "pi-fd-",
    persistFullOutput: async (full) => {
      persisted = full;
      return "/tmp/fake/output.txt";
    },
  });
  assert.isTrue(formatted.truncated);
  assert.equal(formatted.fullOutputPath, "/tmp/fake/output.txt");
  assert.equal(persisted, bigOutput);
  assert.match(formatted.text, /\[Output truncated: 2000 of 3000 lines/);
  assert.match(
    formatted.text,
    /Full output saved to: \/tmp\/fake\/output\.txt\]/,
  );
  const shownLines = formatted.text.split("\n");
  assert.equal(shownLines[0], "file-0.ts");
});
