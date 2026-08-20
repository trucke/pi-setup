/** Resolve the required system fd, ripgrep, and fzf executables. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Data, Effect } from "effect";

const execFileAsync = promisify(execFile);

export type ToolName = "fd" | "rg" | "fzf";
export type BinarySource = "system";

export interface ToolSpec {
  readonly tool: ToolName;
  /** Commands probed on PATH, in order. Debian/Ubuntu install fd as `fdfind`. */
  readonly systemCommands: readonly string[];
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  fd: { tool: "fd", systemCommands: ["fd", "fdfind"] },
  rg: { tool: "rg", systemCommands: ["rg"] },
  fzf: { tool: "fzf", systemCommands: ["fzf"] },
};

export class MissingBinaryError extends Data.TaggedError("MissingBinaryError")<{
  readonly message: string;
}> {}

export interface BinaryEnv {
  /** True when the executable runs and supports the flags this tool requires. */
  readonly probe: (command: string, tool: ToolName) => Effect.Effect<boolean>;
}

export interface ResolvedBinary {
  readonly tool: ToolName;
  readonly command: string;
  readonly source: BinarySource;
}

export function resolveBinary(
  spec: ToolSpec,
  env: BinaryEnv,
): Effect.Effect<ResolvedBinary, MissingBinaryError> {
  return Effect.gen(function* () {
    for (const command of spec.systemCommands) {
      if (yield* env.probe(command, spec.tool)) {
        return { tool: spec.tool, command, source: "system" };
      }
    }

    const expected = spec.systemCommands
      .map((command) => `\`${command}\``)
      .join(" or ");
    return yield* new MissingBinaryError({
      message: `file-search requires ${expected} on PATH. Install ${spec.tool} and restart Pi.`,
    });
  });
}

export const liveBinaryEnv: BinaryEnv = {
  probe: (command, tool) =>
    Effect.promise(async () => {
      try {
        // fd is probed with the flags the tools rely on; rg and fzf just
        // need to run at all.
        const args =
          tool === "fd"
            ? ["--max-results", "1", "--strip-cwd-prefix", "--print0", "--", ""]
            : ["--version"];
        await execFileAsync(command, args, { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    }),
};
