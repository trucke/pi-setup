import { basename, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { runCommand } from "./process.ts";
import { findVcs, type VcsKind } from "./vcs.ts";

const DIFF_SCROLL_STEP = 5;
const MAX_DIFF_LINES = 20_000;
const JJ_CHANGED_FILES_TEMPLATE = 'path ++ "\\0" ++ status_char ++ "\\0"';

// Strip terminal control sequences from repository-controlled paths and diff
// text before applying trusted theme styling.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTerminalText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

interface ChangedPath {
  path: string;
  status: string;
}

export interface ChangedFile {
  additions: number | null;
  deletions: number | null;
  diff: string[];
  name: string;
  path: string;
}

export function parseGitChangedPaths(output: string) {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push({ path, status });

    // In porcelain v1 -z output, rename/copy records are followed by the old path.
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

export function parseJjChangedPaths(output: string) {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index + 1 < records.length; index += 2) {
    const path = records[index];
    const status = records[index + 1];
    if (path && status) paths.push({ path, status });
  }

  return paths;
}

function parseNumstat(output: string) {
  const line = output.split("\n").find(Boolean);
  if (!line) return { additions: 0, deletions: 0 };

  const [added, deleted] = line.split("\t");
  return {
    additions: added === "-" ? null : Number.parseInt(added ?? "0", 10),
    deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "0", 10),
  };
}

export function countGitDiffLines(output: string) {
  let additions = 0;
  let deletions = 0;
  let binary = false;

  for (const line of output.split("\n")) {
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      binary = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return binary
    ? { additions: null, deletions: null }
    : { additions, deletions };
}

function cleanDisplayPath(path: string) {
  return sanitizeTerminalText(path).replace(/[\r\n\t]/g, " ");
}

const runGit = (cwd: string, args: string[]) =>
  runCommand("git", args, cwd, 10_000);

const runJj = (cwd: string, args: string[]) =>
  runCommand("jj", ["--no-pager", "--color=never", ...args], cwd, 10_000);

const loadGitFile = Effect.fn("vcs-info.loadGitFile")(function* (
  repoRoot: string,
  changedPath: ChangedPath,
  hasHead: boolean,
) {
  const useNoIndex = changedPath.status === "??" || !hasHead;
  const diffArguments = useNoIndex
    ? [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "--",
        "/dev/null",
        changedPath.path,
      ]
    : [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        changedPath.path,
      ];
  const statArguments = useNoIndex
    ? ["diff", "--no-index", "--numstat", "--", "/dev/null", changedPath.path]
    : ["diff", "--numstat", "HEAD", "--", changedPath.path];
  const [diffResult, statResult] = yield* Effect.all(
    [runGit(repoRoot, diffArguments), runGit(repoRoot, statArguments)],
    { concurrency: "unbounded" },
  );

  return makeChangedFile(
    changedPath.path,
    diffResult.stdout,
    parseNumstat(statResult.stdout),
  );
});

const loadJjFile = Effect.fn("vcs-info.loadJjFile")(function* (
  repoRoot: string,
  changedPath: ChangedPath,
) {
  const diffResult = yield* runJj(repoRoot, [
    "--ignore-working-copy",
    "diff",
    "--git",
    "--context=3",
    "--",
    changedPath.path,
  ]);

  return makeChangedFile(
    changedPath.path,
    diffResult.stdout,
    countGitDiffLines(diffResult.stdout),
  );
});

function makeChangedFile(
  path: string,
  diffOutput: string,
  stats: { additions: number | null; deletions: number | null },
) {
  const allDiffLines = diffOutput
    .trimEnd()
    .split("\n")
    .map(sanitizeTerminalText);
  const diff =
    allDiffLines.length > MAX_DIFF_LINES
      ? [
          ...allDiffLines.slice(0, MAX_DIFF_LINES),
          `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`,
        ]
      : allDiffLines;

  return {
    ...stats,
    diff:
      diff.length === 1 && diff[0] === ""
        ? ["No textual diff available."]
        : diff,
    name: cleanDisplayPath(basename(path)),
    path: cleanDisplayPath(path),
  } satisfies ChangedFile;
}

const loadChangedPaths = Effect.fn("vcs-info.loadChangedPaths")(function* (
  kind: VcsKind,
  repoRoot: string,
) {
  if (kind === "jj") {
    const result = yield* runJj(repoRoot, [
      "diff",
      "-T",
      JJ_CHANGED_FILES_TEMPLATE,
    ]);
    return result.code === 0 ? parseJjChangedPaths(result.stdout) : null;
  }

  const result = yield* runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return result.code === 0 ? parseGitChangedPaths(result.stdout) : null;
});

const loadRepositoryChanges = Effect.fn("vcs-info.loadRepositoryChanges")(
  function* (cwd: string) {
    const repository = yield* findVcs(cwd);
    if (!repository) return null;

    const changedPaths = yield* loadChangedPaths(
      repository.kind,
      repository.root,
    );
    return changedPaths ? { changedPaths, repository } : null;
  },
);

export const loadChangedFilePaths = Effect.fn("vcs-info.loadChangedFilePaths")(
  function* (cwd: string) {
    const changes = yield* loadRepositoryChanges(cwd);
    return changes
      ? changes.changedPaths.map(({ path }) =>
          resolve(changes.repository.root, path),
        )
      : null;
  },
);

export const loadChangedFiles = Effect.fn("vcs-info.loadChangedFiles")(
  function* (cwd: string) {
    const changes = yield* loadRepositoryChanges(cwd);
    if (!changes) return null;

    const { changedPaths, repository } = changes;
    let hasHead = true;
    if (repository.kind === "git") {
      const headResult = yield* runGit(repository.root, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      hasHead = headResult.code === 0;
    }

    const files: ChangedFile[] = [];
    for (const changedPath of changedPaths) {
      files.push(
        repository.kind === "jj"
          ? yield* loadJjFile(repository.root, changedPath)
          : yield* loadGitFile(repository.root, changedPath, hasHead),
      );
    }

    return files;
  },
);

function padToWidth(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export async function showChangedFiles(
  ctx: ExtensionContext,
  files: ChangedFile[],
) {
  if (ctx.mode !== "tui") return;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let focus: "files" | "diff" = "files";
      let selectedIndex = 0;
      let sidebarOffset = 0;
      let diffOffset = 0;

      function bodyHeight() {
        return Math.max(8, Math.floor(tui.terminal.rows * 0.8) - 2);
      }

      function ensureSelectedFileVisible() {
        const visibleFiles = Math.max(1, Math.floor(bodyHeight() / 2));
        if (selectedIndex < sidebarOffset) sidebarOffset = selectedIndex;
        if (selectedIndex >= sidebarOffset + visibleFiles) {
          sidebarOffset = selectedIndex - visibleFiles + 1;
        }
      }

      function moveFile(amount: number) {
        selectedIndex = (selectedIndex + amount + files.length) % files.length;
        diffOffset = 0;
        ensureSelectedFileVisible();
        tui.requestRender();
      }

      function moveDiff(amount: number) {
        const maxOffset = Math.max(
          0,
          files[selectedIndex]!.diff.length - bodyHeight(),
        );
        diffOffset = Math.max(0, Math.min(maxOffset, diffOffset + amount));
        tui.requestRender();
      }

      function styleDiffLine(line: string) {
        const expanded = line.replaceAll("\t", "    ");
        if (
          expanded.startsWith("diff --git") ||
          expanded.startsWith("index ")
        ) {
          return theme.fg("accent", theme.bold(expanded));
        }
        if (expanded.startsWith("@@")) return theme.fg("mdHeading", expanded);
        if (expanded.startsWith("---") || expanded.startsWith("+++")) {
          return theme.fg("muted", expanded);
        }
        if (expanded.startsWith("+")) return theme.fg("success", expanded);
        if (expanded.startsWith("-")) return theme.fg("error", expanded);
        if (expanded.startsWith("…")) return theme.fg("warning", expanded);
        return theme.fg("text", expanded);
      }

      function border(width: number, label: string, top: boolean) {
        const left = top ? "┌" : "└";
        const right = top ? "┐" : "┘";
        const text = `─ ${label} `;
        const remaining = Math.max(0, width - visibleWidth(text) - 2);
        return theme.fg(
          "borderAccent",
          truncateToWidth(
            `${left}${text}${"─".repeat(remaining)}${right}`,
            width,
            "",
          ),
        );
      }

      function handleInput(data: string) {
        if (focus === "files") {
          if (matchesKey(data, Key.escape)) {
            done(undefined);
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            moveFile(1);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            moveFile(-1);
            return;
          }
          if (matchesKey(data, Key.home) || data === "g") {
            selectedIndex = 0;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.end) || data === "G") {
            selectedIndex = files.length - 1;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.right) ||
            data === "l"
          ) {
            focus = "diff";
            tui.requestRender();
          }
          return;
        }

        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.left) ||
          data === "h"
        ) {
          focus = "files";
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          moveDiff(DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          moveDiff(-DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          moveDiff(Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          moveDiff(-Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.home) || data === "g") {
          diffOffset = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.end) || data === "G") {
          diffOffset = Math.max(
            0,
            files[selectedIndex]!.diff.length - bodyHeight(),
          );
          tui.requestRender();
        }
      }

      function render(width: number) {
        const height = bodyHeight();
        const sidebarWidth = Math.min(
          48,
          Math.max(24, Math.floor(width * 0.34)),
        );
        const diffWidth = Math.max(1, width - sidebarWidth - 3);
        const selectedFile = files[selectedIndex]!;
        const title = `local changes · ${files.length} ${files.length === 1 ? "file" : "files"} · ${focus === "files" ? "FILES" : "DIFF"}`;
        const lines = [border(width, title, true)];

        for (let row = 0; row < height; row += 1) {
          const fileIndex = sidebarOffset + Math.floor(row / 2);
          const file = files[fileIndex];
          let sidebar = "";

          if (file) {
            const isSelected = fileIndex === selectedIndex;
            if (row % 2 === 0) {
              const marker = isSelected ? "› " : "  ";
              const isBinary =
                file.additions === null || file.deletions === null;
              const stats = isBinary
                ? "binary"
                : `+${file.additions} -${file.deletions}`;
              const styledStats = isBinary
                ? theme.fg("success", stats)
                : `${theme.fg("success", `+${file.additions}`)} ${theme.fg("error", `-${file.deletions}`)}`;
              const nameWidth = Math.max(
                1,
                sidebarWidth - visibleWidth(marker) - visibleWidth(stats) - 1,
              );
              const name = truncateToWidth(file.name, nameWidth, "…");
              const gap = " ".repeat(
                Math.max(
                  1,
                  sidebarWidth -
                    visibleWidth(marker) -
                    visibleWidth(name) -
                    visibleWidth(stats),
                ),
              );
              sidebar = `${marker}${name}${gap}${styledStats}`;
            } else {
              sidebar = `  ${theme.fg("dim", truncateToWidth(file.path, Math.max(1, sidebarWidth - 2), "…"))}`;
            }

            sidebar = padToWidth(sidebar, sidebarWidth);
            if (isSelected) {
              sidebar = theme.bg(
                focus === "files" ? "selectedBg" : "customMessageBg",
                sidebar,
              );
            }
          } else {
            sidebar = " ".repeat(sidebarWidth);
          }

          const diffLine = selectedFile.diff[diffOffset + row];
          const diff = padToWidth(
            diffLine === undefined ? "" : styleDiffLine(diffLine),
            diffWidth,
          );
          const separator = theme.fg(
            focus === "diff" ? "borderAccent" : "borderMuted",
            "│",
          );
          lines.push(
            `${theme.fg("borderMuted", "│")}${sidebar}${separator}${diff}${theme.fg("borderMuted", "│")}`,
          );
        }

        const help =
          focus === "files"
            ? "j/k or ↑/↓ select · enter/space/l open diff · esc close"
            : "j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/h files";
        lines.push(border(width, help, false));
        return lines;
      }

      return {
        handleInput,
        invalidate() {},
        render,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "90%",
        minWidth: 60,
        width: "95%",
      },
    },
  );
}
