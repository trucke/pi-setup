import { hostname } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./changed-files-view.ts";

const COMMAND_NAME = "diff";

type ChangedFilesLoader = (cwd: string) => Promise<string[] | null>;

export function getStringPath(input: unknown) {
  if (!input || typeof input !== "object" || !("path" in input)) {
    return undefined;
  }
  return typeof input.path === "string" ? input.path : undefined;
}

export function collectChangedFiles(
  current: Set<string>,
  baseline: Set<string>,
  touched: Set<string>,
) {
  return new Set([
    ...[...current].filter((file) => !baseline.has(file)),
    ...touched,
  ]);
}

function toAbsolute(cwd: string, filePath: string) {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath);
}

function toRelative(cwd: string, filePath: string) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function displayPath(cwd: string, filePath: string) {
  return sanitizeTerminalText(toRelative(cwd, filePath)).replace(
    /[\r\n\t]/g,
    " ",
  );
}

function localZedCommand() {
  return hostname().split(".")[0] === "loki" ? "zeditor" : undefined;
}

export function registerLastAgentChanges(
  pi: ExtensionAPI,
  loadChangedFiles: ChangedFilesLoader,
) {
  let baseline = new Set<string>();
  let changedFiles = new Set<string>();
  let toolTouchedFiles = new Set<string>();

  const load = async (cwd: string) =>
    new Set((await loadChangedFiles(cwd)) ?? []);

  pi.on("agent_start", async (_event, ctx) => {
    toolTouchedFiles = new Set();
    changedFiles = new Set();
    baseline = await load(ctx.cwd);
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const filePath = getStringPath(event.input);
    if (filePath) toolTouchedFiles.add(toAbsolute(ctx.cwd, filePath));
  });

  pi.on("agent_end", async (_event, ctx) => {
    changedFiles = collectChangedFiles(
      await load(ctx.cwd),
      baseline,
      toolTouchedFiles,
    );

    if (changedFiles.size > 0) {
      ctx.ui.notify(
        `${changedFiles.size} changed file(s). Run /${COMMAND_NAME} to view them.`,
        "info",
      );
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Show files changed by the last agent run",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const arg = args.trim();
      if (arg === "clear") {
        changedFiles = new Set();
        toolTouchedFiles = new Set();
        baseline = await load(ctx.cwd);
        ctx.ui.notify("Cleared changed file list", "info");
        return;
      }

      const files = [...changedFiles]
        .map((file) => ({ file, label: displayPath(ctx.cwd, file) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (files.length === 0) {
        ctx.ui.notify(
          "No changed files tracked from the last agent run",
          "info",
        );
        return;
      }

      if (arg === "list") {
        ctx.ui.notify(
          `Changed files:\n${files.map(({ label }) => `- ${label}`).join("\n")}`,
          "info",
        );
        return;
      }

      if (arg) {
        ctx.ui.notify(
          `Unknown /${COMMAND_NAME} argument: ${arg}. Try /${COMMAND_NAME}, /${COMMAND_NAME} list, or /${COMMAND_NAME} clear.`,
          "warning",
        );
        return;
      }

      const zedCommand = localZedCommand();
      const selected = await ctx.ui.select(
        zedCommand ? "Open changed file in Zed" : "Select changed file",
        files.map(({ label }) => label),
      );
      if (!selected) return;

      const file = files.find(({ label }) => label === selected)?.file;
      if (!file) return;

      if (!zedCommand) {
        ctx.ui.notify(
          `Changed file: ${selected}\nOpen it from the active Zed remote project.`,
          "info",
        );
        return;
      }

      const result = await pi.exec(zedCommand, ["-e", file], {
        cwd: ctx.cwd,
        timeout: 5_000,
      });
      ctx.ui.notify(
        result.code === 0
          ? `Opened ${selected} in Zed`
          : result.stderr.trim() || `Failed to open ${selected} in Zed`,
        result.code === 0 ? "info" : "error",
      );
    },
  });
}
