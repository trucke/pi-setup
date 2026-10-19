/**
 * CLIProxyAPI provider: GPT uses Responses with WebSocket continuation; Claude uses Messages.
 * Opt-in through `<agent-dir>/cliproxyapi.json`.
 */
import path from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
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
const STARTUP_CHECK_TIMEOUT_MS = 8_000;
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
      await proxy.initialize(path.join(agentDir, "models-store.json"));
      pi.registerProvider(proxy.provider);
    }
  }

  let activeCheck:
    { sessionId: string; controller: AbortController } | undefined;
  let checkError: string | undefined;
  let statusViewSession: string | undefined;
  const report = (
    ctx: ExtensionContext,
    text: string,
    level: "info" | "warning" | "error",
  ) => {
    const safe = text.split("\n").map(printable).join("\n");
    if (ctx.hasUI) ctx.ui.notify(safe, level);
    else process.stderr.write(`${safe}\n`);
  };
  const reportSetup = (ctx: ExtensionContext) =>
    report(
      ctx,
      formatStatus({ load, ...(setupError ? { setupError } : {}) }),
      "warning",
    );
  const showStatus = (ctx: ExtensionContext) => {
    if (!proxy) return reportSetup(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    if (ctx.hasUI) statusViewSession = sessionId;
    report(
      ctx,
      formatStatus({
        load,
        registered: {
          auth: ctx.modelRegistry.getProviderAuthStatus(proxy.provider.id),
          catalog: proxy.status(),
          sessions: proxy.transport.status(),
          sessionId,
          checking: activeCheck?.sessionId === sessionId,
          ...(checkError ? { checkError } : {}),
        },
      }),
      "info",
    );
  };

  const refreshCatalog = async (ctx: ExtensionContext, automatic: boolean) => {
    const active = proxy;
    if (!active) return reportSetup(ctx);
    if (activeCheck) {
      if (!automatic)
        report(ctx, "CPA model refresh is already in progress.", "info");
      return;
    }
    const operation = {
      sessionId: ctx.sessionManager.getSessionId(),
      controller: new AbortController(),
    };
    activeCheck = operation;
    checkError = undefined;
    const signal = AbortSignal.any([
      operation.controller.signal,
      AbortSignal.timeout(
        automatic ? STARTUP_CHECK_TIMEOUT_MS : REFRESH_TIMEOUT_MS,
      ),
    ]);
    if (!automatic)
      report(ctx, "Refreshing CPA models from the server…", "info");
    try {
      const result = await ctx.modelRegistry.refresh({
        providers: [active.provider.id],
        allowNetwork: true,
        force: !automatic,
        signal,
      });
      if (operation.controller.signal.aborted) return;
      if (result.aborted || signal.aborted)
        checkError = "the model check timed out";
      else {
        const error = result.errors.get(active.provider.id);
        const status = active.status();
        if (error) checkError = error.message;
        else if (status.scope !== "verified" || status.source === "none")
          checkError = "the model check did not complete";
      }
      if (!automatic) {
        if (checkError)
          report(
            ctx,
            `CPA model refresh failed: ${checkError}; keeping the previous catalog.`,
            "error",
          );
        else {
          const catalog = active.status().catalog;
          report(
            ctx,
            `CLIProxyAPI catalog refreshed: ${catalog.models.length} models, ${catalog.hidden.length} hidden.`,
            "info",
          );
        }
      }
    } catch (error) {
      if (operation.controller.signal.aborted) return;
      checkError = error instanceof Error ? error.message : "unexpected error";
      if (!automatic)
        report(
          ctx,
          `CPA model refresh failed: ${checkError}; keeping the previous catalog.`,
          "error",
        );
    } finally {
      if (activeCheck === operation) {
        activeCheck = undefined;
        // Update a visible status snapshot, but never replace a model table or an agent reply.
        if (automatic && statusViewSession === operation.sessionId)
          showStatus(ctx);
      }
    }
  };

  if (proxy) {
    const active = proxy;
    const providerId = active.provider.id;
    const unregisterCleanup = registerSessionResourceCleanup((sessionId) =>
      active.transport.closeSession(sessionId),
    );
    const resetSession = (_event: unknown, ctx: ExtensionContext) =>
      active.transport.closeSession(ctx.sessionManager.getSessionId());
    pi.on("session_start", (event, ctx) => {
      const registry = ctx.modelRegistry;
      active.setReferenceLookup((provider, id) => {
        try {
          return registry.find(provider, id) ?? bundledReference(provider, id);
        } catch {
          return bundledReference(provider, id);
        }
      });
      // Pi owns TUI startup refreshes. Only supply the missing pass for RPC and later reloads.
      const piOwnsStartupRefresh =
        ctx.mode === "tui" && event.reason === "startup";
      if (
        ctx.hasUI &&
        !piOwnsStartupRefresh &&
        process.env.PI_OFFLINE === undefined &&
        registry.getProviderAuthStatus(providerId).configured
      )
        void refreshCatalog(ctx, true);
      else
        void registry
          .refresh({ providers: [providerId], allowNetwork: false })
          .catch((error: unknown) => {
            checkError =
              error instanceof Error
                ? error.message
                : "cached model restore failed";
          });
    });
    pi.on("agent_start", (_event, ctx) => {
      if (statusViewSession === ctx.sessionManager.getSessionId())
        statusViewSession = undefined;
    });
    pi.on("session_compact", resetSession);
    pi.on("session_tree", resetSession);
    pi.on("model_select", resetSession);
    pi.on("session_shutdown", (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      active.transport.closeSession(sessionId);
      if (activeCheck?.sessionId === sessionId) {
        activeCheck.controller.abort();
        activeCheck = undefined;
      }
      if (statusViewSession === sessionId) statusViewSession = undefined;
      unregisterCleanup();
    });
  }

  pi.registerCommand("proxy", {
    description: `CLIProxyAPI provider: ${USAGE}`,
    getArgumentCompletions: (prefix) => {
      const argument = prefix.trim();
      // Pi consumes Enter to accept argument completions, even for an exact match.
      if (ACTIONS.includes(argument)) return null;
      return ACTIONS.filter((value) => value.startsWith(argument)).map(
        (value) => ({ value, label: value }),
      );
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "refresh") return refreshCatalog(ctx, false);
      if (action === "models") {
        statusViewSession = undefined;
        if (!proxy || load.status !== "ok") return reportSetup(ctx);
        const width =
          ctx.mode === "tui" ? (process.stdout.columns ?? 120) - 2 : 120;
        report(
          ctx,
          formatModels(load.config, proxy.status(), Date.now(), width),
          "info",
        );
        return;
      }
      if (action !== "status") {
        report(ctx, `Usage: ${USAGE}`, "warning");
        return;
      }
      showStatus(ctx);
    },
  });
}
