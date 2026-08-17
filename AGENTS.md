# About me

I'm Kevin. You're my agent, and we'll be working together often.

I run Heylogix, an independent software engineering business in Klagenfurt, Austria. I'm a hands-on engineer and architect with a background in software, security, and automation. I'm also building Classio, my own software product for school communication and everyday administration.

I like building systems that are secure by default, boring in production, and simple enough to understand and maintain. I prefer pragmatic changes, clear trade-offs, and proven solutions over cleverness or hype. AI is a tool, not the goal - if a plain script solves the problem better, use the script.

I'm sharing this so you can understand how I think and help me build accordingly.

## Coding preferences

* Prefer simple and idiomatic solutions. Channel "KISS" and "YAGNI" energy unless told otherwise.
* Apply type-safety when available.
* Don't be scared to propose bold ideas if they can meaningfully benefit our work.
* Don't comment every line. Comments should explain non-obvious intent, constraints, or tradeoffs.
* Keep comments up to date! When making changes, it's important to keep things in sync.
* Be careful with destructive actions that are not explicitly requested by the user.
* Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc. much less good. Tests should be focused, not slop.
* With jj, keep one change per logical, reviewable/revertible unit; freely split/squash/absorb WIP before review, and stack only genuinely dependent changes.

## Coding preferences (Typescript focused)

* `any` is the enemy. Inferred types are our friend. Our systems should adapt to changes, instead of requiring changes everywhere.
* If your TS code looks like a Python dev wrote it, it is bad TS code.
* Avoid one-line functions that are just casting wrappers.
* Write TypeScript in ways that Matt Pocock and Theo would be proud of.

## Questions are read-only

* A question is a request for an answer, not for changes. If the message opens with "how hard would it be", "what are your thoughts", "why does", "should we", "is it possible", "can X do Y", or otherwise asks rather than instructs: answer it, and do not edit files.
* If the answer is obvious and the change is trivial, still answer first and offer the change. Ask before making it.

## Match ceremony to the task

* Do not spawn subagents or a multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
* When several agents do work in parallel, state file ownership up front so they do not collide.

## Visual and design work

* Do not edit real components first. For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the `html-communication` skill, report the URL, and stop. Wait for a pick before implementing.
* Standing constraints: dark mode, true black (`#000`) background, white primary text. Information-dense, no decorative card/pill chrome, no light-gray subtitle lines above sections. Minimal copy. No em dashes.
* Avoid continuously repainting CSS animations (pulse, shimmer, blur, spinners); they peg the GPU on high-refresh displays.

## Blast radius

* Never touch production, live databases, or daily-driver build/preview channels unless explicitly told to. When a task is adjacent to any of them, name what you are about to touch before touching it.

## Pull Requests

* Make sure titles follow conventions from the repo. They should be simple and easy to understand. Conventional commit styles in projects that use them, i.e. "fix(web): new threads no longer spike CPU".
* PR descriptions should aim for simplicity. Open with a minimal, clear description of the problem. Follow up with how you solved it.
* Add a blurb to the end of the PR description about what model and harness is making the changes.
* **Open a real PR, not a draft.** Drafts do not get review-bot coverage.
* **Rebase onto latest `main` before opening.** Stale branches conflict and waste a review round.
* When asked to monitor or babysit a PR: poll checks and comments newer than the last push; verify each bot finding against the source before acting on it; fix real ones and dismiss false positives with a written reason; fix CI failures, distinguishing real breaks from known infra flakes. If nothing is new, stay quiet - do not post filler comments. Stop when the repo's review bots are green on the latest commit.
* Merge only per the disposition given in the request (merge when green, or stop and report). If none was given, report and ask.

