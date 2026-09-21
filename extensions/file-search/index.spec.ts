import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";
import {
  buildFdArgs,
  buildFuzzyFdArgs,
  buildFzfArgs,
  buildRgArgs,
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
import {
  executeFuzzyPipeline,
  makeNulDelimitedCollector,
} from "./src/fuzzy.ts";
import { makeBinaryInitializers } from "./index.ts";

// --- argument construction -------------------------------------------------

it("fd args: options are translated, clamped, and a flag-like pattern stays behind --", () => {
  assert.deepEqual(
    buildFdArgs({
      pattern: "-rf",
      path: "@src",
      type: "file",
      extension: ".ts",
      hidden: true,
      maxDepth: 500,
      limit: 1_000_000,
    }),
    [
      "--color=never",
      "--hidden",
      "--type",
      "f",
      "--extension",
      "ts",
      "--max-depth",
      "64",
      "--max-results",
      "10000",
      "--",
      "-rf",
      "src",
    ],
  );
});

it("rg args: a flag-like pattern stays behind -- and case options are exclusive", () => {
  const args = buildRgArgs({
    pattern: "--help",
    path: "@lib",
    fixedStrings: true,
    caseSensitive: false,
    limit: 10,
  });
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "--help", "lib"]);
  assert.isTrue(args.includes("--fixed-strings"));
  assert.isTrue(args.includes("--ignore-case"));
  assert.isFalse(args.includes("--smart-case"));
  assert.deepEqual(
    args.slice(args.indexOf("--max-count"), args.indexOf("--")),
    ["--max-count", "10"],
  );
});

it("fuzzy args: fd emits NUL-delimited candidates and the fzf query cannot become a flag", () => {
  assert.deepEqual(
    buildFuzzyFdArgs({ query: "usrctrl", path: "@src", type: "directory" }),
    [
      "--color=never",
      "--print0",
      "--strip-cwd-prefix",
      "--type",
      "d",
      "--",
      "",
      "src",
    ],
  );
  assert.deepEqual(buildFzfArgs({ query: "--help" }), [
    "--read0",
    "--print0",
    "--scheme=path",
    "--filter=--help",
  ]);
});

it("path normalization strips leading @ and expands ~", () => {
  assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
  assert.equal(normalizeSearchPath("~/projects"), join(homedir(), "projects"));
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

it.effect(
  "binary resolution: one missing tool does not disable the other",
  () =>
    Effect.gen(function* () {
      const initializers = makeBinaryInitializers(makeEnv(["rg"]));

      const fdError = yield* Effect.flip(initializers.fd);
      const rg = yield* initializers.rg;

      assert.instanceOf(fdError, MissingBinaryError);
      assert.match(fdError.message, /requires `fd` or `fdfind`/);
      assert.deepEqual(rg, { tool: "rg", command: "rg", source: "system" });
    }),
);

// --- fuzzy pipeline --------------------------------------------------------

it("NUL collector: splits across chunks and counts beyond the limit", () => {
  const encoder = new TextEncoder();
  const collector = makeNulDelimitedCollector(2);
  collector.observe(encoder.encode("a/b.ts\0we ird\nna"));
  collector.observe(encoder.encode("me.ts\0c.ts\0d.ts"));
  const matches = collector.finish();

  assert.deepEqual(matches.paths, ["a/b.ts", "we ird\nname.ts"]);
  assert.equal(matches.matchCount, 4);
});

it.effect(
  "fuzzy pipeline connects source stdout to filter stdin NUL-safely",
  () =>
    Effect.gen(function* () {
      const result = yield* executeFuzzyPipeline({
        source: {
          command: process.execPath,
          args: ["-e", 'process.stdout.write("one.ts\\0dir/two two.ts\\0")'],
        },
        filter: {
          command: process.execPath,
          args: ["-e", "process.stdin.pipe(process.stdout)"],
        },
        cwd: process.cwd(),
        limit: 1,
      });

      assert.equal(result.sourceCode, 0);
      assert.equal(result.filterCode, 0);
      assert.deepEqual(result.paths, ["one.ts"]);
      assert.equal(result.matchCount, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fuzzy pipeline surfaces source failures with stderr", () =>
  Effect.gen(function* () {
    const result = yield* executeFuzzyPipeline({
      source: {
        command: process.execPath,
        args: ["-e", 'process.stderr.write("boom"); process.exit(3)'],
      },
      filter: {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
      },
      cwd: process.cwd(),
      limit: 10,
    });

    assert.equal(result.sourceCode, 3);
    assert.equal(result.sourceStderr, "boom");
    assert.equal(result.matchCount, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
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
