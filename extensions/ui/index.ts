import { homedir } from "node:os";
import { basename, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyFirecrawlUsageState,
  FIRECRAWL_USAGE_CHANNEL,
  REFRESH_CHANNEL,
  isFirecrawlUsageState,
} from "../shared/dashboard-state.ts";
import { fitFooterLine, type FooterSegment } from "./footer-layout.ts";
import { registerVcsInfo } from "./vcs/index.ts";
import { emptyVcsInfoState, type VcsInfoState } from "./vcs/state.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

interface ModelInfo {
  provider: string;
  modelId: string;
  thinking: string;
  contextPercent: number | null;
  cost: number;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
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

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
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

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

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
    contextPercent: null,
    cost: 0,
  };
  let vcsInfo = emptyVcsInfoState();
  let firecrawlUsage = emptyFirecrawlUsageState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];

  function refreshModelInfo(ctx: ExtensionContext) {
    const model = ctx.model;
    const next: ModelInfo = {
      provider: model?.provider ?? "",
      modelId: model?.id ?? "",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextPercent: ctx.getContextUsage()?.percent ?? null,
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

  const stopFirecrawlUsageListener = pi.events.on(
    FIRECRAWL_USAGE_CHANNEL,
    (value) => {
      if (!isFirecrawlUsageState(value)) return;
      if (
        firecrawlUsage.creditsUsed === value.creditsUsed &&
        firecrawlUsage.budget === value.budget &&
        firecrawlUsage.unlimited === value.unlimited
      ) {
        return;
      }
      firecrawlUsage = value;
      requestRender?.();
    },
  );

  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(
        setTimeout(() => {
          if (hideThemesSection(tui)) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
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
          if (modelInfo.contextPercent !== null) {
            const percent = Math.round(modelInfo.contextPercent);
            const color =
              percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted";
            right.push({
              text: theme.fg(color, `ctx ${percent}%`),
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
          if (firecrawlUsage.creditsUsed > 0) {
            const budget = firecrawlUsage.unlimited
              ? "∞"
              : firecrawlUsage.budget;
            right.push({
              text: theme.fg(
                "muted",
                `FC ${firecrawlUsage.creditsUsed}/${budget} cr`,
              ),
              compactText: theme.fg(
                "muted",
                `FC ${firecrawlUsage.creditsUsed}/${budget}`,
              ),
              compactAt: 5,
              dropAt: 10,
            });
          }

          const lines = [fitFooterLine(left, right, width, separator)];
          const statusText = Array.from(
            footerData.getExtensionStatuses().entries(),
          )
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

  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopFirecrawlUsageListener();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
