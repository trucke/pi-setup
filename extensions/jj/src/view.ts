import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../ui/vcs/changed-files-view.ts";
import { checked, type Run } from "./actions.ts";
import type { Action, LogEntry } from "./model.ts";

const actions: Record<
  string,
  Action | "undo" | "bookmark" | "push" | "revset" | "all" | "refresh"
> = {
  d: "describe",
  s: "sign",
  S: "unsign",
  n: "new",
  e: "edit",
  x: "squash",
  a: "abandon",
  u: "undo",
  b: "bookmark",
  p: "push",
  r: "revset",
  A: "all",
  R: "refresh",
};
export interface Selection {
  index: number;
  change?: string;
}
const clean = (value: string) =>
  sanitizeTerminalText(value).replaceAll("\t", "    ");
const oneLine = (value: string) => clean(value).replace(/[\r\n]/g, " ");

export async function showHistory(
  ctx: ExtensionContext,
  run: Run,
  entries: LogEntry[],
  selection: Selection,
  revset: string | undefined,
  status: string,
) {
  const stable = entries.findIndex(
    (entry) => entry.revision.change === selection.change,
  );
  selection.index =
    stable >= 0
      ? stable
      : Math.max(0, Math.min(selection.index, entries.length - 1));
  return ctx.ui.custom<(typeof actions)[string] | undefined>(
    (tui, theme, kb, done) => {
      let detail = false;
      let fullDiff = false;
      let offset = 0;
      let preview = "";
      let controller: AbortController | undefined;
      let closed = false;
      function selected() {
        return entries[selection.index]?.revision;
      }
      function loadPreview() {
        controller?.abort();
        controller = new AbortController();
        const current = controller;
        const revision = selected();
        selection.change = revision?.change;
        offset = 0;
        preview = "Loading diff…";
        if (!revision) {
          preview = "No revisions matched. Press r to change the revset.";
          return;
        }
        void run(
          ["diff", "-r", revision.id, fullDiff ? "--git" : "--stat"],
          current.signal,
        )
          .then((result) => {
            if (!closed && !current.signal.aborted) {
              preview = clean(checked(result));
              tui.requestRender();
            }
          })
          .catch((error: unknown) => {
            if (!closed && !current.signal.aborted) {
              preview = clean(String(error));
              tui.requestRender();
            }
          });
      }
      loadPreview();
      return {
        dispose() {
          closed = true;
          controller?.abort();
        },
        invalidate() {},
        handleInput(data) {
          if (data === "q" || kb.matches(data, "tui.select.cancel")) {
            if (detail) {
              detail = false;
              offset = 0;
              tui.requestRender();
            } else done(undefined);
            return;
          }
          if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
            detail = !detail;
            offset = 0;
          } else if (data === "f") {
            fullDiff = !fullDiff;
            detail = true;
            loadPreview();
          } else if (data === "j" || kb.matches(data, "tui.select.down")) {
            if (detail) offset += 1;
            else {
              selection.index = Math.min(
                entries.length - 1,
                selection.index + 1,
              );
              loadPreview();
            }
          } else if (data === "k" || kb.matches(data, "tui.select.up")) {
            if (detail) offset = Math.max(0, offset - 1);
            else {
              selection.index = Math.max(0, selection.index - 1);
              loadPreview();
            }
          } else if (matchesKey(data, Key.pageDown)) offset += 10;
          else if (matchesKey(data, Key.pageUp))
            offset = Math.max(0, offset - 10);
          else if (actions[data]) {
            done(actions[data]);
            return;
          }
          tui.requestRender();
        },
        render(width) {
          const hints = wrapTextWithAnsi(
            "j/k ↑/↓ move · enter/tab detail · f diff · d describe · s/S sign/unsign · n new · e edit · x squash · a abandon · u undo · b bookmark · p push · r revset · A all/default · R refresh · q/esc back",
            width,
          );
          const height = Math.max(1, tui.terminal.rows - hints.length - 4);
          const logHeight = detail ? 0 : Math.max(1, Math.floor(height / 2));
          const revision = selected();
          const lines = [
            theme.fg(
              "accent",
              truncateToWidth(
                `jj · ${revset ?? "default revset"} · ${entries.length} revisions · ${detail ? "DETAIL" : "LOG"}`,
                width,
              ),
            ),
          ];
          lines.push(
            theme.fg("warning", truncateToWidth(oneLine(status), width)),
          );
          if (!detail) {
            const graphLines: string[] = [];
            let selectedLine = 0;
            for (const [index, entry] of entries.entries()) {
              const r = entry.revision;
              if (index === selection.index) selectedLine = graphLines.length;
              const markers = [
                r.working && "@",
                r.empty && "empty",
                r.conflict && "conflict",
                r.immutable && "immutable",
                r.signed ? "signed" : "unsigned",
              ]
                .filter(Boolean)
                .join(" ");
              const id =
                theme.fg("accent", theme.bold(r.prefix)) +
                theme.fg("dim", r.rest);
              let row = `${index === selection.index ? "›" : " "} ${clean(entry.graph)}${id} ${oneLine(r.description.split("\n")[0] || "(no description)")} ${theme.fg("muted", `${oneLine(r.author)} ${r.date}`)} ${theme.fg("success", oneLine(r.bookmarks.join(" ")))} ${theme.fg(r.conflict ? "error" : "dim", `[${markers}]`)}`;
              row = truncateToWidth(row, width);
              graphLines.push(
                index === selection.index ? theme.bg("selectedBg", row) : row,
              );
              graphLines.push(
                ...entry.continuation.map((line) => `  ${clean(line)}`),
              );
            }
            const start = Math.max(0, selectedLine - Math.floor(logHeight / 2));
            for (let i = 0; i < logHeight; i++)
              lines.push(truncateToWidth(graphLines[start + i] ?? "", width));
          }
          lines.push(
            theme.fg(
              "borderAccent",
              truncateToWidth(
                `─ ${fullDiff ? "diff" : "description / stat"} ${revision ? revision.prefix + revision.rest : ""} ${detail ? "(j/k or pgup/pgdn scroll)" : ""} ` +
                  "─".repeat(width),
                width,
                "",
              ),
            ),
          );
          const body = wrapTextWithAnsi(
            clean(revision?.description || "(no description)") + "\n" + preview,
            width,
          );
          const available = Math.max(1, height - logHeight);
          offset = Math.max(0, Math.min(offset, body.length - available));
          for (let i = 0; i < available; i++) {
            const line = body[offset + i] ?? "";
            lines.push(
              theme.fg(
                line.startsWith("+")
                  ? "success"
                  : line.startsWith("-")
                    ? "error"
                    : "text",
                truncateToWidth(line, width),
              ),
            );
          }
          lines.push(...hints.map((hint) => theme.fg("dim", hint)));
          return lines;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
