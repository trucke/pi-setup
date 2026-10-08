import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../ui/vcs/changed-files-view.ts";
import type { CommandResult } from "../../ui/vcs/process.ts";
import {
  actionArgs,
  bookmarkArgs,
  parseBookmarkNames,
  pushArgs,
  type Action,
  type Revision,
} from "./model.ts";

export type Run = (
  args: string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;
const clean = sanitizeTerminalText;

export function checked(result: CommandResult) {
  if (result.code !== 0)
    throw new Error(
      result.stderr ||
        `jj failed (exit ${result.code}; command may have timed out)`,
    );
  return result.stdout;
}

// jj 0.46 creates explicitly selected remote bookmarks without --allow-new.
// Confirmation of the successful dry run authorizes exactly that proposed push.
export async function pushBookmark(
  name: string,
  run: Run,
  confirm: (output: string) => Promise<boolean>,
) {
  const preview = await run(pushArgs(name, true));
  checked(preview);
  if (!(await confirm(preview.stdout + preview.stderr))) return false;
  checked(await run(pushArgs(name, false)));
  return true;
}

export async function withProgress<T>(
  ctx: ExtensionContext,
  title: string,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const outcome = await ctx.ui.custom<{ value: T } | { error: unknown }>(
    (_tui, theme, _kb, done) => {
      const controller = new AbortController();
      let settled = false;
      void work(controller.signal).then(
        (value) => {
          settled = true;
          done({ value });
        },
        (error: unknown) => {
          settled = true;
          done({ error });
        },
      );
      const text = new Text(
        theme.fg(
          "accent",
          `${title}… (esc cancels; remote may already have changed)`,
        ),
        1,
        1,
      );
      return {
        render: (width) => text.render(width),
        invalidate: () => text.invalidate(),
        handleInput(data) {
          if (matchesKey(data, Key.escape)) controller.abort();
        },
        dispose() {
          if (!settled) controller.abort();
        },
      };
    },
  );
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

async function chooseBookmark(
  ctx: ExtensionContext,
  run: Run,
  create: boolean,
) {
  const names = parseBookmarkNames(
    checked(
      await run([
        "bookmark",
        "list",
        "-T",
        'if(!remote && present, json(name) ++ "\\n")',
      ]),
    ),
  );
  const choices = names.map((name) => clean(name));
  const newLabel = "+ Create a new bookmark";
  if (create) choices.unshift(newLabel);
  if (!choices.length) {
    ctx.ui.notify("No local bookmarks", "info");
    return;
  }
  const choice = await ctx.ui.select("Bookmark", choices);
  if (choice === undefined) return;
  if (create && choice === newLabel)
    return (await ctx.ui.input("New bookmark name"))?.trim() || undefined;
  return names[choices.indexOf(choice) - (create ? 1 : 0)];
}

export async function performAction(
  ctx: ExtensionContext,
  run: Run,
  action: Action | "undo" | "bookmark" | "push",
  revision: Revision | undefined,
) {
  if (action === "undo") {
    const operation = checked(
      await run([
        "op",
        "log",
        "-n",
        "1",
        "--no-graph",
        "-T",
        'description ++ "\\n"',
      ]),
    );
    if (await ctx.ui.confirm("Undo latest operation?", clean(operation)))
      checked(await run(["undo"]));
    return;
  }
  if (action === "push") {
    const name = await chooseBookmark(ctx, run, false);
    if (!name) return;
    await pushBookmark(
      name,
      async (args) =>
        withProgress(
          ctx,
          args.includes("--dry-run") ? "Checking push" : "Pushing",
          (signal) => run(args, signal),
        ),
      (output) => ctx.ui.confirm(`Push ${clean(name)}?`, clean(output)),
    );
    return;
  }
  if (!revision) return;
  const id = revision.id;
  if (action === "bookmark") {
    const name = await chooseBookmark(ctx, run, true);
    if (!name) return;
    const result = await run(bookmarkArgs(name, id));
    if (result.code !== 0 && result.stderr.includes("--allow-backwards")) {
      if (
        await ctx.ui.confirm(
          `Move ${clean(name)} backwards or sideways?`,
          clean(result.stderr),
        )
      ) {
        checked(await run(bookmarkArgs(name, id, true)));
      }
    } else checked(result);
    return;
  }
  let description = "";
  if (action === "describe") {
    const value = await ctx.ui.editor(
      `Describe ${revision.prefix}${revision.rest}`,
      revision.description,
    );
    if (value === undefined) return;
    description = value;
  }
  if (action === "squash" || action === "abandon") {
    const message =
      `${revision.prefix}${revision.rest}: ${clean(revision.description) || "(no description)"}` +
      (action === "squash"
        ? "\nSquash into parent, keeping the parent's description."
        : "");
    if (
      !(await ctx.ui.confirm(
        `${action === "squash" ? "Squash" : "Abandon"} revision?`,
        message,
      ))
    )
      return;
  }
  checked(
    await withProgress(ctx, `jj ${action}`, (signal) =>
      run(actionArgs(action, id, description), signal),
    ),
  );
}
