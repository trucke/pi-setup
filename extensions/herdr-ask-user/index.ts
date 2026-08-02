import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_USER_TOOL_NAME = "ask_user";
const BLOCKED_LABEL = "Waiting for your answer";

export default function herdrAskUser(pi: ExtensionAPI) {
  const activeToolCalls = new Set<string>();

  function reportBlocked(active: boolean) {
    pi.events.emit("herdr:blocked", {
      active,
      ...(active ? { label: BLOCKED_LABEL } : {}),
    });
  }

  pi.on("tool_execution_start", (event) => {
    if (
      event.toolName !== ASK_USER_TOOL_NAME ||
      activeToolCalls.has(event.toolCallId)
    ) {
      return;
    }

    activeToolCalls.add(event.toolCallId);
    reportBlocked(true);
  });

  pi.on("tool_execution_end", (event) => {
    if (
      event.toolName !== ASK_USER_TOOL_NAME ||
      !activeToolCalls.delete(event.toolCallId)
    ) {
      return;
    }

    reportBlocked(false);
  });

  pi.on("session_shutdown", () => {
    for (const _toolCallId of activeToolCalls) {
      reportBlocked(false);
    }
    activeToolCalls.clear();
  });
}
