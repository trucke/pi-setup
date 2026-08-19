import { Effect } from "effect";
import { runCommand } from "./process.ts";

const COMMAND_TIMEOUT_MS = 3_000;
const JJ_DIFF_TEMPLATE = 'path ++ "\\0" ++ status_char ++ "\\0"';
const JJ_REVISION_TEMPLATE =
  'change_id.short(8) ++ "\\0" ++ bookmarks.join("\\0") ++ "\\0"';

export type VcsKind = "git" | "jj";

export interface VcsRepository {
  kind: VcsKind;
  root: string;
}

export interface VcsSnapshot extends VcsRepository {
  changedFiles: number;
  label: string;
  pullRequestRefs: string[];
}

const runJj = (cwd: string, args: string[]) =>
  runCommand(
    "jj",
    ["--no-pager", "--color=never", ...args],
    cwd,
    COMMAND_TIMEOUT_MS,
  );

const runGit = (cwd: string, args: string[]) =>
  runCommand("git", args, cwd, COMMAND_TIMEOUT_MS);

function nonEmptyRecords(output: string) {
  return output.split("\0").filter(Boolean);
}

export function parseJjRevision(output: string) {
  const [changeId = "", ...bookmarks] = nonEmptyRecords(output);
  return { bookmarks, changeId };
}

export function countJjChanges(output: string) {
  return Math.floor(nonEmptyRecords(output).length / 2);
}

export function countGitChanges(output: string) {
  const records = output.split("\0");
  let count = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const status = record.slice(0, 2);
    count += 1;
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return count;
}

export const findVcs = Effect.fn("vcs-info.findVcs")(function* (cwd: string) {
  const jjRoot = yield* runJj(cwd, ["--ignore-working-copy", "root"]);
  if (jjRoot.code === 0 && jjRoot.stdout.trim()) {
    return {
      kind: "jj",
      root: jjRoot.stdout.trim(),
    } satisfies VcsRepository;
  }

  const gitRoot = yield* runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.code === 0 && gitRoot.stdout.trim()) {
    return {
      kind: "git",
      root: gitRoot.stdout.trim(),
    } satisfies VcsRepository;
  }

  return null;
});

export const loadVcsSnapshot = Effect.fn("vcs-info.loadVcsSnapshot")(function* (
  cwd: string,
  snapshotWorkingCopy = true,
) {
  const repository = yield* findVcs(cwd);
  if (!repository) return null;

  if (repository.kind === "jj") {
    // Event-driven refreshes snapshot the working copy. Polls can read the
    // current operation without creating JJ operations every few seconds.
    const diff = yield* runJj(repository.root, [
      ...(snapshotWorkingCopy ? [] : ["--ignore-working-copy"]),
      "diff",
      "-T",
      JJ_DIFF_TEMPLATE,
    ]);
    const revision = yield* runJj(repository.root, [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      JJ_REVISION_TEMPLATE,
    ]);
    const { bookmarks, changeId } =
      revision.code === 0
        ? parseJjRevision(revision.stdout)
        : { bookmarks: [], changeId: "" };
    const bookmarkLabel = bookmarks.join(",");
    const label =
      bookmarkLabel && changeId
        ? `${bookmarkLabel} · ${changeId}`
        : bookmarkLabel || changeId || "@";

    return {
      ...repository,
      changedFiles: diff.code === 0 ? countJjChanges(diff.stdout) : 0,
      label,
      pullRequestRefs: bookmarks,
    } satisfies VcsSnapshot;
  }

  const [branchResult, headResult, statusResult] = yield* Effect.all(
    [
      runGit(repository.root, ["branch", "--show-current"]),
      runGit(repository.root, ["rev-parse", "--short", "HEAD"]),
      runGit(repository.root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ],
    { concurrency: "unbounded" },
  );
  const branch = branchResult.stdout.trim();
  const shortHead = headResult.stdout.trim();

  return {
    ...repository,
    changedFiles:
      statusResult.code === 0 ? countGitChanges(statusResult.stdout) : 0,
    label: branch || (shortHead ? `detached@${shortHead}` : "detached"),
    pullRequestRefs: branch ? [branch] : [],
  } satisfies VcsSnapshot;
});
