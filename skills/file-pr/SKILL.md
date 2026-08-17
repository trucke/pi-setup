---
name: file-pr
description: File a concise pull request. Use when the user asks to file, open, or create a PR.
---

# File PR

Before filing:

- Check whether a PR already exists for the current branch.
- Rebase onto the latest `main` unless the repository uses a different base branch.
- Review the local diff against the remote base branch (usually `origin/main`) and confirm it matches the user's goal.

PR titles usually become commit messages. Follow the repository's title conventions, using recently merged PRs and Git history as examples. Prefer a concise, human-readable title that explains why the change matters:

```text
BAD
perf(server): negotiate permessage-deflate on the websocket

GOOD
perf(server): cut websocket frame size by 70%+ with gzipping
```

Open the description with a simple explanation of the problem based on the user's original prompt, then briefly explain the solution. Do not lead with an implementation inventory:

```text
BAD
Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD
My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.
```

End the description with a short note naming the model and harness that made the changes.

Open a real PR rather than a draft so review bots run. If the user also asked to monitor or babysit it, continue with the `babysit-pr` skill.

Follow the user's requested disposition: merge when green only when asked, or stop and report. If the user did not specify what to do once the PR is ready, report and ask.
