import { Data, Effect, Result, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_FORCE_KILL_AFTER_MS = 5_000;

export class PdfProcessError extends Data.TaggedError("PdfProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PdfProcessTimeoutError extends Data.TaggedError(
  "PdfProcessTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

function withUnrefTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  command: string,
  timeoutMs: number,
) {
  const timeout = Effect.callback<never, PdfProcessTimeoutError>((resume) => {
    const timer = setTimeout(
      () =>
        resume(
          Effect.fail(
            new PdfProcessTimeoutError({
              message: `${command} timed out after ${timeoutMs / 1_000} seconds.`,
              timeoutMs,
            }),
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    return Effect.sync(() => clearTimeout(timer));
  });
  return Effect.raceFirst(effect, timeout);
}

function collectBounded(
  stream: Stream.Stream<Uint8Array, unknown>,
  maxBytes: number,
  command: string,
) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  return Stream.runForEach(stream, (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      return Effect.fail(
        new PdfProcessError({
          message: `${command} produced more than ${maxBytes} bytes of output.`,
        }),
      );
    }
    chunks.push(chunk);
    return Effect.void;
  }).pipe(Effect.map(() => Buffer.concat(chunks, bytes).toString("utf8")));
}

function collectStderr(stream: Stream.Stream<Uint8Array, unknown>) {
  const chunks: Uint8Array[] = [];
  let retained = 0;
  return Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      if (retained >= MAX_STDERR_BYTES) return;
      const next = chunk.subarray(0, MAX_STDERR_BYTES - retained);
      chunks.push(next);
      retained += next.byteLength;
    }),
  ).pipe(Effect.map(() => Buffer.concat(chunks, retained).toString("utf8")));
}

export interface PdfCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly maxStdoutBytes: number;
  readonly timeoutMs: number;
  /** Internal/test override for scoped SIGTERM-to-SIGKILL escalation. */
  readonly forceKillAfterMs?: number;
}

/** Runs one bounded Poppler process whose lifetime follows the surrounding fiber. */
export function runPdfCommand(options: PdfCommandOptions) {
  const program = Effect.gen(function* () {
    const process = yield* ChildProcess.make(options.command, options.args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    yield* Effect.addFinalizer(() =>
      process.isRunning.pipe(
        Effect.flatMap((running) => {
          if (!running) return Effect.void;
          return process.kill({ killSignal: "SIGTERM" }).pipe(
            Effect.timeout(
              options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS,
            ),
            Effect.result,
            Effect.flatMap((exit) =>
              Result.isFailure(exit)
                ? process.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
        }),
        Effect.ignore,
      ),
    );
    const result = yield* Effect.all(
      {
        stdout: collectBounded(
          process.stdout,
          options.maxStdoutBytes,
          options.command,
        ),
        stderr: collectStderr(process.stderr),
        exitCode: process.exitCode,
      },
      { concurrency: "unbounded" },
    );
    const code = Number(result.exitCode);
    if (code !== 0) {
      const detail = result.stderr.trim() || `exit code ${code}`;
      return yield* new PdfProcessError({
        message: `${options.command} failed: ${detail}`,
      });
    }
    return result.stdout;
  });

  return withUnrefTimeout(program, options.command, options.timeoutMs).pipe(
    Effect.mapError((cause) =>
      cause instanceof PdfProcessError ||
      cause instanceof PdfProcessTimeoutError
        ? cause
        : new PdfProcessError({
            message: `Could not run ${options.command}: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
    ),
    Effect.scoped,
  );
}
