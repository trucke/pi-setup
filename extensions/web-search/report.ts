import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import packageJson from "../../package.json" with { type: "json" };
import { FetchError, NETWORK_CODES } from "../shared/fetch-error.ts";
import {
  PUBLIC_HTTP_USER_AGENT,
  resolvePublicUrl,
  type ResolveHost,
} from "../shared/public-http.ts";
import { parsePublicHttpUrl } from "../shared/public-url.ts";

export const REPORT_TITLE = "web-fetch local failure reproduction";
export const REPORT_REPO = "https://github.com/trucke/pi-setup";
const exec = promisify(execFile);

export async function validateReproduction(
  input: string,
  signal: AbortSignal,
  resolve?: ResolveHost,
) {
  // Do not silently strip components or normalize whitespace supplied by the user.
  if (input.length > 300 || /[\s<>`\\?#\u0000-\u001f\u007f]/u.test(input))
    throw new Error(
      "Use a public URL of at most 300 characters, without query, fragment or whitespace.",
    );
  const url = parsePublicHttpUrl(input);
  if (url.search || url.hash)
    throw new Error("Query and fragment are not allowed.");
  await resolvePublicUrl(
    url,
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    resolve,
  );
  return url.href;
}

function version(value: string) {
  return /^[a-zA-Z0-9.+_-]{1,64}$/.test(value) ? value : "unknown";
}

// No freeform diagnostics or body parameter. Explicitly pick every published field.
export function buildReport(
  reproduction: string,
  failure: FetchError,
  timeout: number,
) {
  const diagnostics = {
    category: [
      "timeout",
      "network",
      "http",
      "content",
      "redirect",
      "unknown",
    ].includes(failure.category)
      ? failure.category
      : "unknown",
    code:
      failure.code && NETWORK_CODES.has(failure.code)
        ? failure.code
        : undefined,
    httpStatus:
      failure.category === "http" &&
      Number.isInteger(failure.status) &&
      failure.status! >= 100 &&
      failure.status! <= 599
        ? failure.status
        : undefined,
    timeoutMs:
      Number.isInteger(timeout) && timeout >= 1 && timeout <= 120_000
        ? timeout
        : 30_000,
    maxBytes: 5 * 1024 * 1024,
    maxRedirects: 5,
    packageVersion: version(packageJson.version),
    piVersion: version(VERSION),
    nodeVersion: version(process.versions.node),
    bunVersion: process.versions.bun
      ? version(process.versions.bun)
      : undefined,
    platform: version(process.platform),
    arch: version(process.arch),
  };
  return [
    "```text",
    "Reproduce using this user-supplied public URL (not tested):",
    `web-fetch ${JSON.stringify({ url: reproduction, timeout: diagnostics.timeoutMs })}`,
    "Expected: readable local page content.",
    "Observed on ORIGINAL URL (omitted), NOT the supplied URL:",
    `Failure=${diagnostics.category}; code=${diagnostics.code ?? "none"}; HTTP=${diagnostics.httpStatus ?? "none"}`,
    `Local: timeout=${diagnostics.timeoutMs}ms; max=${diagnostics.maxBytes}B; redirects=${diagnostics.maxRedirects}`,
    `UA=${PUBLIC_HTTP_USER_AGENT}; encoding=identity; JS=no; credentials=no`,
    `Versions: pi-setup=${diagnostics.packageVersion}; Pi=${diagnostics.piVersion}`,
    `Runtime: Node=${diagnostics.nodeVersion}${diagnostics.bunVersion ? `; Bun=${diagnostics.bunVersion}` : ""}; ${diagnostics.platform}/${diagnostics.arch}`,
    "```",
    "",
  ].join("\n");
}

export async function submitReport(
  reproduction: string,
  failure: FetchError,
  timeout: number,
  signal: AbortSignal,
  run: (
    command: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<unknown> = exec,
) {
  signal.throwIfAborted();
  await validateReproduction(reproduction, signal);
  const dir = await mkdtemp(join(tmpdir(), "pi-fetch-report-"));
  try {
    const path = join(dir, "report.md");
    await writeFile(path, buildReport(reproduction, failure, timeout), {
      mode: 0o600,
    });
    signal.throwIfAborted();
    await run(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        REPORT_REPO,
        "--title",
        REPORT_TITLE,
        "--body-file",
        path,
      ],
      {
        signal,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 16_384,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
