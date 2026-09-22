# Pi setup

Personal [Pi](https://pi.dev/) package based on
[`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup).

## Installation

Install a reviewed release globally:

```sh
pi install git:github.com/trucke/pi-setup@v0.5.1
```

Pi manages the checkout and runtime dependencies. Do not clone this repository
over `~/.pi/agent`. Installed tags stay pinned until explicitly updated.
The package does not deploy personal or global agent instructions.

Install these executables on `PATH` for the features you use:

| Feature                 | Requirements                                  |
| ----------------------- | --------------------------------------------- |
| File search             | `fd` (or `fdfind`), `rg` and `fzf` 0.35+      |
| PDF reading             | Poppler (`pdfinfo` and `pdftotext`)           |
| Claude subagents        | Claude Code, authenticated with `claude auth` |
| Codex subagents         | Codex CLI, authenticated with `codex login`   |
| Optional GitHub reports | `gh`, already signed in                       |

## Included tools and commands

- Dashboard with per-response runtime, VCS status and changed-file views,
  preferring JJ over Git.
- Herdr-aware `ask-user`, background terminals and `fd`/`rg`/`fuzzy-find` file search.
- `read-pdf` for local files and public PDF URLs, using Poppler rather than OCR.
- Web search, page fetching and Developer Index search, described below.
- Pi, Claude Code and Codex subagents, with companion skills for subagents and
  background terminals.
- `/undo` rewinds the latest user turn and restores its text to the editor.
  The old branch remains in `/tree`. It requires an idle agent and does not undo
  files or other side effects.
- `/recap` summarizes the current task, progress and next step in at most 40 words.
- `/fast on|off` requests priority for supported `openai-codex` models. It is off
  by default, resets on reload or session replacement and can only change while
  idle. Priority uses more credits; the dashboard indicator shows the request,
  not confirmation of faster service. Reasoning effort is unchanged.

To use the included theme, set `"theme": "github-dark-default"` in
`~/.pi/agent/settings.json`.

## Web tools

No credentials are required. Results are untrusted source material, not
instructions. Inline output is sanitized and limited to 16KB or 400 lines;
truncated output includes a file path for reading the rest. Expand tool cards
with Ctrl+O to see their content.

### Search

`web-search` uses anonymous Exa MCP with Firecrawl fallback for recognized
transient failures, rate limits and unavailable pages. Authentication, billing,
validation and cancellation failures never trigger fallback. Empty results are
valid. Requests do not use configured API keys.

Results contain source URLs and excerpts, not synthesized answers. Domain and
recency filters are supported. Set `provider: "exa"` or `provider: "firecrawl"`
for an explicit request with automatic fallback disabled.

### Page fetching and privacy

`web-fetch` reads public HTTP(S) pages directly from this machine. It validates
DNS and redirects, blocks private destinations and sends no cookies or
credentials. HTML becomes readable text; JavaScript does not run. Downloads are
limited to 5 MiB, with a default timeout of 30 seconds.

Eligible local failures offer permission to send the exact URL to Exa, with
Firecrawl fallback. Approval applies only to that request. Declining or
dismissing sends nothing; headless runs remain local-only. Hosted providers
control their own redirects and browser behavior.

A separate report offer requires a user-supplied public, non-sensitive
reproduction URL. The failed URL is never copied or prefilled. You review the
exact report before separately approving publication to
[`trucke/pi-setup`](https://github.com/trucke/pi-setup) under your signed-in GitHub
account, not anonymously. Reports contain allowlisted diagnostics, not raw
errors, logs, page content, headers or session data. Unsafe/invalid requests,
cancellation and headless runs do not offer reporting. Report failures do not
discard successful fetched content. If submission fails, check GitHub before
retrying: an issue may already exist.

For a separate explicit `web-fetch-hosted` tool, set `PI_WEB_HOSTED_FETCH=1` in
the process environment before starting Pi. It sends URLs to third parties;
use it only when disclosure is appropriate, never to bypass declined consent.
This setting is not needed for consent-based recovery.

### Developer Index

`developer-search` searches library docs, upstream issues, merged pull requests
and READMEs through Firecrawl's Developer Index. Scope queries with `types`,
`repos` or `sources`; coverage reports identify degraded or unavailable indexes.

Only this tool reads optional `FIRECRAWL_API_KEY`, first from the process
environment, then from `~/.pi/agent/.env`. A configured key uses account limits.
See [`.env.example`](.env.example). Never commit credentials.

## Subagents

Use `subagent-spawn` with a release-pinned profile, or `subagent-spawn-direct`
when requesting a particular harness or model. Profiles have no automatic model
fallback. Direct runs need their role and constraints in the prompt.

Up to four runs can be active. Recovery artifacts are stored under
`~/.pi/agent/state/subagents/` and restored only for the same parent session.
Interrupted runs require explicit `subagent-resume`; they never restart
automatically. See [Subagents architecture](extensions/subagents/docs/design-plan.md)
for profiles, guidance loading and recovery behavior.

## Development

Use pnpm and edit this source repository, not an installed package checkout.
Before releasing, run:

```sh
pnpm test
pnpm check
pnpm format:check
pnpm pack --dry-run
```

See [AGENTS.md](AGENTS.md) for repository and release guidelines.
