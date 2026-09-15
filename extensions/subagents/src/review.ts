import type { ReviewTarget } from "./domain.ts";

/** Validate both public tool input and recorded targets before rendering commands. */
export function resolveReviewTarget(value: unknown): ReviewTarget {
  if (!value || typeof value !== "object") {
    throw new Error("reviewTarget must be an object.");
  }
  const input = value as {
    type?: unknown;
    branch?: unknown;
    sha?: unknown;
    number?: unknown;
  };
  if (input.type === "uncommittedChanges") {
    return { type: "uncommittedChanges" };
  }
  if (input.type === "baseBranch") {
    const branch =
      typeof input.branch === "string" ? input.branch.trim() : undefined;
    if (!branch)
      throw new Error("reviewTarget.branch is required for baseBranch.");
    if (
      !/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.endsWith("/") ||
      branch.endsWith(".") ||
      branch
        .split("/")
        .some(
          (component) =>
            !component ||
            component.startsWith(".") ||
            component.endsWith(".lock"),
        )
    ) {
      throw new Error("reviewTarget.branch must be a safe Git branch name.");
    }
    return { type: "baseBranch", branch };
  }
  if (input.type === "commit") {
    const sha = typeof input.sha === "string" ? input.sha.trim() : undefined;
    if (!sha) throw new Error("reviewTarget.sha is required for commit.");
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
      throw new Error("reviewTarget.sha must be a 7-64 character commit hash.");
    }
    return { type: "commit", sha };
  }
  if (input.type !== "pullRequest")
    throw new Error("Unknown reviewTarget.type.");
  const number = input.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error(
      "reviewTarget.number must be a positive integer for pullRequest.",
    );
  }
  return { type: "pullRequest", number };
}

export function isReviewTarget(value: unknown): value is ReviewTarget {
  try {
    resolveReviewTarget(value);
    return true;
  } catch {
    return false;
  }
}

/** Shared by ordinary agent runs, native review adapters and recovery. */
export function buildReviewPrompt(prompt: string, reviewTarget?: ReviewTarget) {
  if (reviewTarget === undefined) return prompt;
  const target = resolveReviewTarget(reviewTarget);
  const targetInstructions =
    target.type === "uncommittedChanges"
      ? "Review only the current uncommitted and staged changes. Inspect `git diff` and `git diff --cached`."
      : target.type === "baseBranch"
        ? `Review the current branch relative to base branch ${JSON.stringify(target.branch)}. Inspect the merge-base diff (for example, \`git diff ${target.branch}...HEAD\`).`
        : target.type === "commit"
          ? `Review commit ${JSON.stringify(target.sha)}. Inspect that commit and its parent diff (for example, \`git show --format=fuller ${target.sha}\`).`
          : `Review pull request #${target.number}. You may inspect it with read-only \`gh pr view ${target.number}\` and \`gh pr diff ${target.number}\` commands.`;
  return [
    "Perform a read-only review. Do not modify files, create commits, push, or post remote comments.",
    targetInstructions,
    prompt.trim(),
  ].join("\n\n");
}
