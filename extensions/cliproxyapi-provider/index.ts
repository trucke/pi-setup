/**
 * CLIProxyAPI (CPA) provider: GPT routes over CPA's Responses WebSocket with continuation,
 * Claude routes over Anthropic Messages. Opt-in through `<agent-dir>/cliproxyapi.json`.
 */
import path from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  configPath,
  findModelsJsonConflict,
  loadConfig,
} from "./src/config.ts";
import {
  bundledReference,
  createProxyProvider,
  isBuiltinProviderId,
  type ProxyProvider,
} from "./src/provider.ts";
import { formatModels, formatStatus, printable } from "./src/status.ts";

const REFRESH_TIMEOUT_MS = 30_000;
const ACTIONS = ["status", "models", "refresh"];
const USAGE = `/proxy [${ACTIONS.join(" | ")}]`;

export default async function cliproxyapiProvider(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const load = await Effect.runPromise(loadConfig(configPath(agentDir)));

  let proxy: ProxyProvider | undefined;
  let setupError: string | undefined;
  if (load.status === "ok") {
    const { config } = load;
    setupError = isBuiltinProviderId(config.provider)
      ? `"${config.provider}" is a built-in Pi provider; choose another "provider" id`
      : await findModelsJsonConflict(agentDir, config.provider);
    if (!setupError) {
      proxy = createProxyProvider(config);
      // ModelRuntime's default store location (`modelsStorePath`) next to models.json.
      await proxy.initialize(path.join(agentDir, "models-store.json"));
      pi.registerProvider(proxy.provider);
    }
  }

  if (proxy) {
    const active = proxy;
    const providerId = active.provider.id;
    // Pi calls this when a session is disposed, including in-process subagent sessions.
    const unregisterCleanup = registerSessionResourceCleanup((sessionId) =>
      active.transport.closeSession(sessionId),
    );
    const resetSession = (
      _event: unknown,
      ctx: { sessionManager: { getSessionId(): string } },
    ) => active.transport.closeSession(ctx.sessionManager.getSessionId());

    pi.on("session_start", (_event, ctx) => {
      const registry = ctx.modelRegistry;
      active.setReferenceLookup((provider, id) => {
        try {
          return registry.find(provider, id) ?? bundledReference(provider, id);
        } catch {
          return bundledReference(provider, id);
        }
      });
      // Re-run enrichment against the session catalog without touching the network.
      void registry
        .refresh({ providers: [providerId], allowNetwork: false })
        .catch(() => undefined);
    });
    pi.on("session_compact", resetSession);
    pi.on("session_tree", resetSession);
    pi.on("model_select", resetSession);
    pi.on("session_shutdown", (_event, ctx) => {
      active.transport.closeSession(ctx.sessionManager.getSessionId());
      unregisterCleanup();
    });
  }

  const report = (
    ctx: ExtensionCommandContext,
    text: string,
    level: "info" | "warning" | "error",
  ) => {
    const safe = text.split("\n").map(printable).join("\n");
    if (ctx.hasUI) ctx.ui.notify(safe, level);
    else process.stderr.write(`${safe}\n`);
  };

  const reportSetup = (ctx: ExtensionCommandContext) =>
    report(
      ctx,
      formatStatus({ load, ...(setupError ? { setupError } : {}) }),
      "warning",
    );

  pi.registerCommand("proxy", {
    description: `CLIProxyAPI provider: ${USAGE}`,
    getArgumentCompletions: (prefix) =>
      ACTIONS.filter((value) => value.startsWith(prefix.trim())).map(
        (value) => ({ value, label: value }),
      ),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "refresh") {
        if (!proxy) {
          reportSetup(ctx);
          return;
        }
        const id = proxy.provider.id;
        const result = await ctx.modelRegistry.refresh({
          providers: [id],
          allowNetwork: true,
          force: true,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
        const error = result.errors.get(id);
        const catalog = proxy.status().catalog;
        if (result.aborted)
          report(
            ctx,
            "CLIProxyAPI refresh timed out; keeping the previous catalog.",
            "error",
          );
        else if (error)
          report(
            ctx,
            `${error.message}; keeping the previous catalog.`,
            "error",
          );
        else {
          report(
            ctx,
            `CLIProxyAPI catalog refreshed: ${catalog.models.length} models, ${catalog.hidden.length} hidden.`,
            "info",
          );
        }
        return;
      }
      if (action === "models") {
        if (!proxy || load.status !== "ok") {
          reportSetup(ctx);
          return;
        }
        report(ctx, formatModels(load.config, proxy.status()), "info");
        return;
      }
      if (action !== "status") {
        report(ctx, `Usage: ${USAGE}`, "warning");
        return;
      }
      if (!proxy) {
        reportSetup(ctx);
        return;
      }
      report(
        ctx,
        formatStatus({
          load,
          registered: {
            auth: ctx.modelRegistry.getProviderAuthStatus(proxy.provider.id),
            catalog: proxy.status(),
            sessions: proxy.transport.status(),
            sessionId: ctx.sessionManager.getSessionId(),
          },
        }),
        "info",
      );
    },
  });
}
