import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export class MissingApiKeyError extends Data.TaggedError("MissingApiKeyError")<{
  readonly message: string;
}> {}

export type CommandExecutor = Pick<ExtensionAPI, "exec">;

export interface ApiKeyOptions {
  env?: NodeJS.ProcessEnv;
  envPath?: string;
}

function readEnvFileValue(
  name: string,
  envPath = join(homedir(), ".pi", "agent", ".env"),
) {
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

/**
 * Resolves an API key with the shared policy: process environment, then the
 * Infisical project configured at ~/.pi/agent, then ~/.pi/agent/.env.
 */
export async function resolveApiKey(
  name: string,
  pi: CommandExecutor,
  signal?: AbortSignal,
  options: ApiKeyOptions = {},
) {
  const processApiKey = (options.env ?? process.env)[name]?.trim();
  if (processApiKey) return processApiKey;

  try {
    const result = await pi.exec(
      "infisical",
      ["secrets", "get", name, "--plain", "--silent"],
      {
        cwd: join(homedir(), ".pi", "agent"),
        signal,
        timeout: 15_000,
      },
    );
    const infisicalApiKey = result.code === 0 ? result.stdout.trim() : "";
    if (infisicalApiKey) return infisicalApiKey;
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  const fileApiKey = readEnvFileValue(name, options.envPath);
  if (fileApiKey) return fileApiKey;

  throw new MissingApiKeyError({
    message: `Missing ${name} in the process environment, Infisical, or ~/.pi/agent/.env`,
  });
}
