/**
 * Fuzzy path matching: an fd candidate generator piped into `fzf --filter`.
 *
 * Both processes are spawned directly (no shell) and connected by streaming
 * fd's stdout into fzf's stdin, so arguments are never shell-interpreted and
 * interrupting the effect tears down both children via the ambient scope.
 * Paths stay NUL-delimited end-to-end (`fd --print0` → `fzf --read0 --print0`)
 * so unusual filenames survive the pipeline.
 */

import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { collectStderr } from "./process.ts";

export interface FuzzyMatches {
  readonly paths: readonly string[];
  readonly matchCount: number;
}

/**
 * Accumulate NUL-delimited entries from a byte stream, retaining at most
 * `limit` paths while counting every match, so memory stays bounded no matter
 * how many matches fzf emits.
 */
export function makeNulDelimitedCollector(limit: number) {
  const decoder = new TextDecoder();
  const paths: string[] = [];
  let pending = "";
  let matchCount = 0;

  const take = (entry: string) => {
    if (entry === "") return;
    matchCount++;
    if (paths.length < limit) paths.push(entry);
  };

  return {
    observe(chunk: Uint8Array) {
      pending += decoder.decode(chunk, { stream: true });
      const entries = pending.split("\0");
      pending = entries.pop() ?? "";
      for (const entry of entries) take(entry);
    },
    finish(): FuzzyMatches {
      take(pending + decoder.decode());
      return { paths, matchCount };
    },
  };
}

export interface PipelineCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface FuzzyPipelineResult {
  readonly sourceCode: number;
  readonly filterCode: number;
  readonly sourceStderr: string;
  readonly filterStderr: string;
  readonly paths: readonly string[];
  readonly matchCount: number;
}

/** Spawn `source | filter` without a shell and drain the ranked matches. */
export function executeFuzzyPipeline(options: {
  readonly source: PipelineCommand;
  readonly filter: PipelineCommand;
  readonly cwd: string;
  readonly limit: number;
}) {
  return Effect.gen(function* () {
    const source = yield* ChildProcess.make(
      options.source.command,
      options.source.args,
      { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const filter = yield* ChildProcess.make(
      options.filter.command,
      options.filter.args,
      {
        cwd: options.cwd,
        stdin: source.stdout,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const collector = makeNulDelimitedCollector(options.limit);
    const result = yield* Effect.all(
      {
        sourceCode: source.exitCode,
        filterCode: filter.exitCode,
        sourceStderr: collectStderr(source.stderr),
        filterStderr: collectStderr(filter.stderr),
        drained: Stream.runForEach(filter.stdout, (chunk) =>
          Effect.sync(() => collector.observe(chunk)),
        ),
      },
      { concurrency: "unbounded" },
    );
    const matches = collector.finish();
    return {
      sourceCode: Number(result.sourceCode),
      filterCode: Number(result.filterCode),
      sourceStderr: result.sourceStderr,
      filterStderr: result.filterStderr,
      paths: matches.paths,
      matchCount: matches.matchCount,
    } satisfies FuzzyPipelineResult;
  }).pipe(Effect.scoped);
}
