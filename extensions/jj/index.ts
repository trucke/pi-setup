import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommand } from "../ui/vcs/process.ts";
import { createRuntime, runEffect } from "../ui/vcs/runtime.ts";
import { sanitizeTerminalText } from "../ui/vcs/changed-files-view.ts";
import { checked, performAction, type Run } from "./src/actions.ts";
import {
  HISTORY_REVSET,
  logArgs,
  parseLog,
  type LogEntry,
} from "./src/model.ts";
import { showHistory, type Selection } from "./src/view.ts";

export default function jjExtension(pi: ExtensionAPI) {
  let open = false;
  pi.registerCommand("jj", {
    description: "Browse Jujutsu history and manage revisions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/jj requires interactive TUI mode", "warning");
        return;
      }
      if (open) return;
      open = true;
      const runtime = createRuntime();
      // Explicit editor configuration and closed stdin keep jj from taking over Pi.
      const run: Run = (args, signal) =>
        runEffect(
          runtime,
          runCommand(
            "jj",
            [
              "--no-pager",
              "--color=never",
              "--config",
              'ui.editor=["false"]',
              "--config",
              "ui.paginate=never",
              "--config",
              "ui.log-word-wrap=false",
              ...args,
            ],
            ctx.cwd,
            120_000,
          ),
          { signal },
        );
      try {
        if ((await run(["root"])).code !== 0) {
          ctx.ui.notify("Not a jj repository", "warning");
          return;
        }
        let revset: string | undefined = HISTORY_REVSET;
        let entries: LogEntry[] = [];
        let status = "";
        const selection: Selection = { index: 0 };
        while (true) {
          try {
            entries = parseLog(checked(await run(logArgs(revset))));
          } catch (error) {
            entries = [];
            status = sanitizeTerminalText(
              error instanceof Error ? error.message : String(error),
            );
            ctx.ui.notify(status, "error");
          }
          const action = await showHistory(
            ctx,
            run,
            entries,
            selection,
            revset,
            status,
          );
          if (!action) break;
          status = "";
          try {
            if (action === "revset") {
              const input = await ctx.ui.input(
                "Revset (empty shows the full history)",
                revset === HISTORY_REVSET ? "" : (revset ?? ""),
              );
              if (input !== undefined) {
                const next = input.trim() || HISTORY_REVSET;
                // Validate before changing the filter, keeping the last good log on errors.
                entries = parseLog(checked(await run(logArgs(next))));
                revset = next;
              }
            } else if (action === "all")
              revset = revset === HISTORY_REVSET ? undefined : HISTORY_REVSET;
            else if (action !== "refresh")
              await performAction(
                ctx,
                run,
                action,
                entries[selection.index]?.revision,
              );
          } catch (error) {
            status = sanitizeTerminalText(
              error instanceof Error ? error.message : String(error),
            );
            ctx.ui.notify(status, "error");
          }
        }
      } finally {
        await runtime.dispose();
        open = false;
      }
    },
  });
}
