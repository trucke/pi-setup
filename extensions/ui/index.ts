import { homedir } from "node:os";
import { basename, relative } from "node:path";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type MarkdownTransformer,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { REFRESH_CHANNEL } from "../shared/dashboard-state.ts";
import { fitFooterLine, type FooterSegment } from "./footer-layout.ts";
import { registerVcsInfo } from "./vcs/index.ts";
import { emptyVcsInfoState, type VcsInfoState } from "./vcs/state.ts";

interface ModelInfo {
  provider: string;
  modelId: string;
  thinking: string;
  contextTokens: number | null;
  contextPercent: number | null;
  cost: number;
}

// A fenced block must start on its own line, so the marker cannot share it.
const FENCE_START = /^\s*(```|~~~)/;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function formatDirectoryCompact(cwd: string) {
  if (cwd === homedir()) return "~";
  return sanitizeTerminalLabel(basename(cwd) || cwd);
}

function formatTokens(tokens: number) {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function prefixMarkdown(prefix: string, markdown: string) {
  return FENCE_START.test(markdown)
    ? `${prefix}\n${markdown}`
    : `${prefix} ${markdown}`;
}

/** Mark transcript roles inline instead of relying on background boxes. */
export const markTranscriptRoles: MarkdownTransformer = (
  markdown,
  { messageType },
) => {
  if (messageType === "user") return prefixMarkdown("›", markdown);
  if (messageType === "assistant-thinking") {
    return prefixMarkdown("_Thinking:_", markdown);
  }
  return markdown;
};

function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }
  return cost;
}

function modelInfoEqual(left: ModelInfo, right: ModelInfo) {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.thinking === right.thinking &&
    left.contextTokens === right.contextTokens &&
    left.contextPercent === right.contextPercent &&
    left.cost === right.cost
  );
}

type VcsRegistrar = (
  pi: ExtensionAPI,
  onStateChange: (state: VcsInfoState) => void,
) => void;

export default function ui(
  pi: ExtensionAPI,
  registerVcs: VcsRegistrar = registerVcsInfo,
) {
  let title = "pi";
  let modelInfo: ModelInfo = {
    provider: "",
    modelId: "",
    thinking: "off",
    contextTokens: null,
    contextPercent: null,
    cost: 0,
  };
  let vcsInfo = emptyVcsInfoState();
  let requestRender: (() => void) | undefined;

  function refreshModelInfo(ctx: ExtensionContext) {
    const model = ctx.model;
    const usage = ctx.getContextUsage();
    const next: ModelInfo = {
      provider: model?.provider ?? "",
      modelId: model?.id ?? "",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      cost: getSessionCost(ctx),
    };
    if (modelInfoEqual(modelInfo, next)) return;
    modelInfo = next;
    requestRender?.();
  }

  registerVcs(pi, (value: VcsInfoState) => {
    if (
      vcsInfo.isRepository === value.isRepository &&
      vcsInfo.kind === value.kind &&
      vcsInfo.label === value.label &&
      vcsInfo.changedFiles === value.changedFiles &&
      vcsInfo.pullRequest?.number === value.pullRequest?.number &&
      vcsInfo.pullRequest?.url === value.pullRequest?.url &&
      vcsInfo.pullRequest?.isDraft === value.pullRequest?.isDraft
    ) {
      return;
    }
    vcsInfo = value;
    requestRender?.();
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      requestRender = () => tui.requestRender();

      return {
        render(width: number) {
          const header = `${theme.fg("text", "▪ pi")} ${theme.fg("dim", `v${VERSION} · ${title}`)}`;
          return [truncateToWidth(header, width)];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const separator = theme.fg("dim", " · ");
          const left: FooterSegment[] = [
            {
              text: theme.fg("text", formatDirectory(ctx.cwd)),
              compactText: theme.fg("text", formatDirectoryCompact(ctx.cwd)),
              compactAt: 25,
              dropAt: 55,
            },
          ];

          if (vcsInfo.kind && vcsInfo.label) {
            left.push({
              text: theme.fg("muted", `${vcsInfo.kind} ${vcsInfo.label}`),
              compactText: theme.fg("muted", vcsInfo.label),
              compactAt: 30,
              dropAt: 50,
            });
          }
          if (vcsInfo.changedFiles > 0) {
            const fileLabel = vcsInfo.changedFiles === 1 ? "file" : "files";
            left.push({
              text: theme.fg(
                "muted",
                `${vcsInfo.changedFiles} ${fileLabel} changed`,
              ),
              compactText: theme.fg("muted", `+${vcsInfo.changedFiles}`),
              compactAt: 35,
              dropAt: 90,
            });
          }
          if (vcsInfo.pullRequest) {
            const fullLabel = `PR #${vcsInfo.pullRequest.number}`;
            const compactLabel = `#${vcsInfo.pullRequest.number}`;
            left.push({
              text: getCapabilities().hyperlinks
                ? hyperlink(fullLabel, vcsInfo.pullRequest.url)
                : fullLabel,
              compactText: getCapabilities().hyperlinks
                ? hyperlink(compactLabel, vcsInfo.pullRequest.url)
                : compactLabel,
              compactAt: 15,
              dropAt: 20,
            });
          }

          const right: FooterSegment[] = [];
          if (modelInfo.modelId) {
            right.push({
              text: theme.fg(
                "muted",
                modelInfo.provider
                  ? `${modelInfo.provider}/${modelInfo.modelId}`
                  : modelInfo.modelId,
              ),
              compactText: theme.fg("muted", modelInfo.modelId),
              compactAt: 40,
            });
          }
          if (modelInfo.thinking !== "off") {
            right.push({
              text: theme.fg("muted", modelInfo.thinking),
              compactText: theme.fg(
                "muted",
                modelInfo.thinking === "medium" ? "med" : modelInfo.thinking,
              ),
              compactAt: 45,
              dropAt: 75,
            });
          }
          const statuses = footerData.getExtensionStatuses();
          if (
            modelInfo.provider === "openai-codex" &&
            statuses.get("openai-fast-mode") === "fast: on"
          ) {
            right.push({ text: theme.fg("accent", "fast") });
          }
          if (modelInfo.contextPercent !== null) {
            const percent = Math.round(modelInfo.contextPercent);
            const color =
              percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted";
            right.push({
              text: theme.fg(
                color,
                modelInfo.contextTokens === null
                  ? `ctx ${percent}%`
                  : `${formatTokens(modelInfo.contextTokens)} (${percent}%)`,
              ),
              compactText: theme.fg(color, `${percent}%`),
              compactAt: 45,
              dropAt: 95,
            });
          }
          if (modelInfo.cost > 0) {
            right.push({
              text: theme.fg("muted", `$${modelInfo.cost.toFixed(2)}`),
              dropAt: 80,
            });
          }

          const lines = [fitFooterLine(left, right, width, separator)];
          const statusText = Array.from(statuses.entries())
            .filter(([key]) => key !== "openai-fast-mode")
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"))
            .map((line) => line.trim())
            .filter(Boolean)
            .join(separator);
          if (statusText) {
            lines.push(
              truncateToWidth(statusText, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.registerMarkdownTransformer(markTranscriptRoles);

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    refreshModelInfo(ctx);
    install(ctx);
  });

  pi.on("model_select", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("thinking_level_select", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("agent_start", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("turn_end", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("agent_settled", (_event, ctx) => refreshModelInfo(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
