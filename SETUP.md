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

## Codex research

The package registers `codex_research`, the preferred tool for current
information and general web research. It runs a one-shot `codex exec` session
(ephemeral, read-only sandbox, empty temporary working directory) with live web
search enabled and returns a concise, cited Markdown answer with at most 10
sources.

It requires the [Codex CLI](https://github.com/openai/codex) on `PATH`,
authenticated via `codex login` with the ChatGPT subscription. No OpenAI API
key is needed, and calls consume no Firecrawl credits. Firecrawl search remains
available as a fallback when Codex is unavailable or structured search-result
listings are needed.

## Firecrawl

The package registers `firecrawl_search`, `firecrawl_scrape`, and
`firecrawl_crawl`. They resolve `FIRECRAWL_API_KEY` in this order:

1. Process environment
2. Infisical project configured at `~/.pi/agent`
3. `~/.pi/agent/.env`

For the file fallback, copy `.env.example` to `~/.pi/agent/.env` and replace the
placeholder. Never commit the resulting file.

Firecrawl retrieval is credit-aware:

- `firecrawl_search` discovers at most 10 results and returns query-relevant
  excerpts when available, without returning complete page content.
- `firecrawl_crawl` defaults to 5 pages.
- Equivalent page scrapes are reused across reloads and resumes, including pages
  already returned by crawls. Set `fresh: true` only when revalidation is needed.
- The default session budget is 20 credits. Interactive sessions can raise the
  budget, allow all remaining requests for the session, or decline; non-interactive
  sessions block requests that would exceed the budget.
- Approved budget settings persist in the session, and the dashboard displays
  `used/budget` credits (`used/∞` when all requests are allowed).

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
