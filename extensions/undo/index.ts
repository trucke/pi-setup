import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "undo";

export function findLatestUserEntryId(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") {
      return entry.id;
    }
  }

  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Rewind the latest user turn and restore its prompt",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify(`Usage: /${COMMAND_NAME}`, "warning");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the agent to finish or interrupt it before using /undo.",
          "warning",
        );
        return;
      }

      const targetId = findLatestUserEntryId(ctx.sessionManager.getBranch());
      if (!targetId) {
        ctx.ui.notify("There is no user turn to undo.", "info");
        return;
      }

      try {
        const result = await ctx.navigateTree(targetId, { summarize: false });
        if (result.cancelled) {
          ctx.ui.notify("Undo cancelled.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Undo failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
