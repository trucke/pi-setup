# Setup

Install the package globally at a reviewed tag or commit:

```sh
pi install git:github.com/trucke/pi-setup@v0.1.0
```

Pi clones the package into its managed git package directory and installs the
root runtime dependencies. Do not clone this repository over `~/.pi/agent`.

## Agent instructions

The root `AGENTS.md` contains repository-specific guidance only. Package installs
do not deploy global agent instructions. Keep personal or machine-wide context in
a separately managed private file.

## File search

The `fd`, `rg`, and `fuzzy-find` tools require system executables on `PATH`:
`fd` (or `fdfind` on Debian/Ubuntu), `rg` (ripgrep), and `fzf` (0.35 or newer
for `--scheme`). Nothing is downloaded at runtime; install the tools with the
system package manager and restart Pi.

## Web tools

The package registers four consolidated web tools: `web-research`,
`web-search`, `web-fetch`, and `web-crawl`.

### web-research

`web-research` is the preferred tool for current information and general web
research. It runs a one-shot `codex exec` session (ephemeral, read-only
sandbox, empty temporary working directory) with live web search enabled and
returns a concise, cited Markdown answer with at most 10 sources.

It requires the [Codex CLI](https://github.com/openai/codex) on `PATH`,
authenticated via `codex login` with the ChatGPT subscription. No OpenAI API
key is needed, and calls consume no search-API credits. `web-search` remains
available as a fallback when Codex is unavailable or structured search-result
listings are needed.

### web-search and web-fetch

Both tools default to the `exa` backend, which calls the Exa Search and
Contents HTTP APIs directly and is the cheap default. The `firecrawl` backend
is the explicit escalation: structured web/news/image search listings for
`web-search`, and robust browser-rendered scraping for `web-fetch`. Backends
never fall back to each other silently; errors name the retry to make.

### web-crawl

`web-crawl` crawls multiple pages of one website with Firecrawl and defaults
to 5 pages.

## Credentials

The tools resolve `EXA_API_KEY` and `FIRECRAWL_API_KEY` in this order:

1. Process environment
2. Infisical project configured at `~/.pi/agent`
3. `~/.pi/agent/.env`

For the file fallback, copy `.env.example` to `~/.pi/agent/.env` and replace the
placeholders. Never commit the resulting file. Credentials are resolved lazily
on first use, so a missing key for one backend does not affect the others.

## Firecrawl credit budgeting

Firecrawl-backed retrieval is credit-aware:

- `web-search` with `backend: "firecrawl"` discovers at most 10 results and
  returns query-relevant excerpts when available, without returning complete
  page content.
- `web-crawl` defaults to 5 pages.
- Equivalent Firecrawl page scrapes are reused across reloads and resumes,
  including pages already returned by crawls and sessions recorded under the
  legacy `firecrawl_*` tool names. Set `fresh: true` only when revalidation is
  needed.
- The default session budget is 20 credits. Interactive sessions can raise the
  budget, allow all remaining requests for the session, or decline; non-interactive
  sessions block requests that would exceed the budget.
- Approved budget settings persist in the session, and the dashboard displays
  `used/budget` credits (`used/∞` when all requests are allowed).

Exa-backed calls (the default for `web-search` and `web-fetch`) never reserve
or consume Firecrawl credits.

## Subagents

The subagent extension supports direct Pi, Claude Code, and Codex runs plus
release-pinned `scout`, `worker`, `reviewer`, and `oracle` profiles. Claude and
Codex candidates require their CLIs on `PATH` and authenticated with
`claude auth` and `codex login` respectively. Profiles may advance to their
next declared candidate after a typed startup rejection, but only before any
assistant or tool activity; the logical run id and attempt history are preserved.

Runs are capped at four concurrently. Receipts, bounded snapshots, normalized
JSONL transcripts, and Markdown output are stored under
`~/.pi/agent/state/subagents/<run-id>/`. They are restored only for the same
parent Pi session and are never resumed automatically; use `subagent-resume`
explicitly. The newest 64 settled artifacts are retained; active-run artifacts are never pruned.

## Theme

The package provides `github-dark-default`. Activate it in
`~/.pi/agent/settings.json` if desired:

```json
{
  "theme": "github-dark-default"
}
```

## Upstream updates

Fetch `upstream/main`, merge it into the fork, resolve package-specific changes,
run the checks, and publish a new tag. Installed tags remain pinned until the Pi
package source is changed explicitly.
