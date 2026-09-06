import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast-mode";
const ROUTING_HEADER = "x-codex-routing-hint";

function supportsFast(model: ExtensionContext["model"]) {
  return (
    model?.provider === "openai-codex" && model.api === "openai-codex-responses"
  );
}

export default function openaiFastMode(pi: ExtensionAPI) {
  let enabled = false;

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      STATUS_KEY,
      enabled
        ? supportsFast(ctx.model)
          ? "fast: on"
          : "fast: on (inactive)"
        : undefined,
    );
  }

  pi.registerCommand("fast", {
    description: "OpenAI Codex priority mode: /fast on|off (uses more credits)",
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode !== "on" && mode !== "off") {
        ctx.ui.notify(
          `Fast mode is ${enabled ? "on" : "off"}. Usage: /fast on|off`,
          "info",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the current run to finish before changing Fast mode.",
          "warning",
        );
        return;
      }
      if (mode === "on" && !supportsFast(ctx.model)) {
        ctx.ui.notify(
          "Fast mode is only available for openai-codex models.",
          "warning",
        );
        return;
      }

      const next = mode === "on";
      if (next !== enabled) {
        // Routing is chosen at connection time, not for each WebSocket message.
        cleanupSessionResources(ctx.sessionManager.getSessionId());
        enabled = next;
      }
      updateStatus(ctx);
      ctx.ui.notify(
        enabled
          ? "Fast mode on: requesting priority, which uses more credits. Speedup is not guaranteed."
          : "Fast mode off: using the provider's normal service tier.",
        enabled ? "warning" : "info",
      );
    },
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!enabled || !supportsFast(ctx.model) || !ctx.model) return;
    // /fast on deliberately owns both tier controls, including explicit overrides.
    for (const key of Object.keys(event.headers)) {
      if (key.toLowerCase() === ROUTING_HEADER) delete event.headers[key];
    }
    event.headers[ROUTING_HEADER] = `model=${ctx.model.id};tier=priority`;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !supportsFast(ctx.model)) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return;
    return { ...payload, service_tier: "priority" };
  });

  pi.on("model_select", (event, ctx) => {
    if (
      enabled &&
      (supportsFast(event.previousModel) || supportsFast(event.model))
    ) {
      cleanupSessionResources(ctx.sessionManager.getSessionId());
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (enabled) cleanupSessionResources(ctx.sessionManager.getSessionId());
    enabled = false;
    updateStatus(ctx);
  });
}
