---
name: babysit-pr
description: Monitor a pull request through review and CI. Use when the user asks to monitor, watch or babysit a PR.
---

# Babysit PR

Use native PR-monitoring tools when available; otherwise poll the host CLI/API. Only act on checks and comments newer than the latest push.

Loop until ready:

- Check required CI, bot/human reviews, and new comments.
- Verify every finding against the current source and original PR goal; review bots can be wrong.
- Fix real findings and repository-caused failures, run focused validation, commit, and push. Treat the new head as the cutoff and ignore stale results.
- Distinguish infrastructure flakes from real failures. Retry known flakes; never change product code to appease broken infrastructure.
- Explain and resolve false positives or feedback not worth addressing. Avoid scope creep.
- Stay quiet when nothing changed.

Track relevant base-branch changes and rebase only when needed. If an overlapping PR makes this one obsolete, stop, report it, and ask before closing unless explicitly authorized.

Format comments left on Kevin's behalf as:

```md
[MODEL-SLUG] RESPONDING ON BEHALF OF KEVIN
-----

[actual reply]
```

Attach screenshots, videos, or other artifacts when materially useful and supported by the harness.

The PR is ready when required checks, reviews, and configured review bots are green on the latest commit and no actionable threads remain. Follow the user's requested disposition: merge when green only when asked, or stop and report. If no disposition was given, report that the PR is ready and ask.
