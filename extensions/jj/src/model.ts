export const LOG_TEMPLATE = `"\\0" ++ json({
  "id" => commit_id,
  "change" => change_id,
  "prefix" => change_id.shortest(8).prefix(),
  "rest" => change_id.shortest(8).rest(),
  "description" => description,
  "author" => author.name(),
  "date" => author.timestamp().format("%Y-%m-%d"),
  "bookmarks" => bookmarks.map(|b| b.name()),
  "working" => current_working_copy,
  "empty" => empty,
  "conflict" => conflict,
  "immutable" => immutable,
  "signed" => if(signature, true, false)
}) ++ "\\n"`;

export interface Revision {
  id: string;
  change: string;
  prefix: string;
  rest: string;
  description: string;
  author: string;
  date: string;
  bookmarks: string[];
  working: boolean;
  empty: boolean;
  conflict: boolean;
  immutable: boolean;
  signed: boolean;
}
export interface LogEntry {
  revision: Revision;
  graph: string;
  continuation: string[];
}

function isRevision(value: unknown): value is Revision {
  if (!value || typeof value !== "object") return false;
  const strings = [
    "id",
    "change",
    "prefix",
    "rest",
    "description",
    "author",
    "date",
  ];
  const booleans = ["working", "empty", "conflict", "immutable", "signed"];
  return (
    strings.every(
      (key) => key in value && typeof Reflect.get(value, key) === "string",
    ) &&
    booleans.every(
      (key) => key in value && typeof Reflect.get(value, key) === "boolean",
    ) &&
    "bookmarks" in value &&
    Array.isArray(value.bookmarks) &&
    value.bookmarks.every((name: unknown) => typeof name === "string")
  );
}

export function parseLog(output: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of output.trimEnd().split("\n")) {
    const marker = line.indexOf("\0");
    if (marker < 0) {
      if (line) entries.at(-1)?.continuation.push(line);
      continue;
    }
    const value: unknown = JSON.parse(line.slice(marker + 1));
    if (!isRevision(value)) throw new Error("Invalid jj log record");
    entries.push({
      revision: value,
      graph: line.slice(0, marker),
      continuation: [],
    });
  }
  if (output.includes("[command output truncated]"))
    throw new Error("jj log output too large; use a narrower revset");
  return entries;
}

export function logArgs(revset?: string) {
  return ["log", ...(revset ? ["-r", revset] : []), "-T", LOG_TEMPLATE];
}

export type Action =
  "describe" | "sign" | "unsign" | "new" | "edit" | "squash" | "abandon";
export function actionArgs(action: Action, id: string, description = "") {
  switch (action) {
    case "describe":
      return ["describe", "-r", id, "-m", description];
    case "new":
    case "edit":
      return [action, id];
    case "squash":
      return ["squash", "-r", id, "--use-destination-message"];
    default:
      return [action, "-r", id];
  }
}

export function bookmarkArgs(name: string, id: string, backwards = false) {
  return [
    "bookmark",
    "set",
    "-r",
    id,
    ...(backwards ? ["--allow-backwards"] : []),
    "--",
    name,
  ];
}

export function pushArgs(name: string, dryRun: boolean) {
  // -b is a glob by default. A selected name must never expand to other bookmarks.
  return [
    "git",
    "push",
    "-b",
    `exact:${name}`,
    ...(dryRun ? ["--dry-run"] : []),
  ];
}

export function parseBookmarkNames(output: string) {
  return [
    ...new Set(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (typeof value !== "string")
            throw new Error("Invalid jj bookmark record");
          return value;
        }),
    ),
  ];
}
