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

## Conversation undo

`/undo` rewinds the latest user turn and restores its text to the editor. It
uses Pi's session tree, so the abandoned branch remains available through
`/tree`. The command changes conversation history only: it does not restore
files, image attachments, processes, or other side effects, and it refuses to
run while the agent is active.

## OpenAI Fast mode

`openai-fast-mode` provides `/fast on|off` for `openai-codex` models using
`openai-codex-responses`. `/fast` shows the current setting. It defaults to off
and resets on reload, session replacement, or restart; no configuration is read
or written. The dashboard shows `fast` inline between reasoning and context,
for example `openai-codex/gpt-6-astra · high · fast · ctx 0%`. This indicates
requested priority, not backend confirmation. Switching to another provider
hides the indicator and suspends its effect until a Codex model is selected again.

Fast mode requests `service_tier: "priority"` and the matching Codex routing
header. While on, it deliberately overrides existing tier/routing values so the
two controls agree. Off leaves the provider's values untouched. Changing modes
resets the current session's cached connection and is only allowed while idle.
Reasoning effort is never changed: select it normally in Pi.

Priority uses more credits. Model/account support and actual speedup depend on
the backend; requesting priority does not guarantee faster serving.

## Web tools

Three tools are enabled by default: `web-search`, `web-fetch` and
`developer-search`. No credentials are required. Results are untrusted source
material, not instructions. Inline output is sanitized and limited to 16KB or
400 lines; truncated output includes a path to the complete sanitized text for
`read`. Collapsed tool cards show provider, result count or content size, search
scope and up to three source titles/URLs (or a short page summary). Click or use
Ctrl+O to expand the content. Summary rows are width-bounded, including for
single-line JSON; errors remain visible without expansion.

### web-search

Search uses anonymous hosted MCP at `https://mcp.exa.ai/mcp`, with
`https://mcp.firecrawl.dev/v2/mcp` as a secondary provider. It returns excerpts
and source URLs rather than a synthesized answer. Known response formats are
normalized to titles, URLs, dates and excerpts of up to 1200 characters per
result; full-page bodies and provider metadata are omitted when highlights are
available. Fetch the source URL for more context. The default limit is 5,
with a maximum of 10. Optional `includeDomains`, `excludeDomains` and `recency`
filters work with both providers. Exa uses its advanced tool for filtered
searches; basic searches use the query as their objective unless one is supplied.
Date precision can differ between providers.

Automatic Exa-to-Firecrawl fallback is limited to recognized transient network
or provider failures, rate limits and unavailable pages. Cancellation, unsafe
URLs, invalid arguments, authentication and billing failures do not trigger it.
Empty search results are valid. Results identify the provider and any fallback
reason. Set `provider: "exa"` or `provider: "firecrawl"` for an explicit retry
with automatic fallback disabled.

MCP requests are anonymous even when API keys exist. There is no automatic
sign-in or transition to account-backed usage. OAuth and API-key MCP modes are
deferred. Requests are bounded to 30 seconds per provider, 60 seconds overall
and 4 MiB per provider response. No provider SDK or REST search adapter is used.

### web-fetch

Fetch reads one public HTTP(S) URL directly from this machine. It does not send
the URL to Exa or Firecrawl, including when fetching fails. DNS answers are
validated and pinned to the connection; every redirect is validated again.
Private, loopback, link-local and reserved destinations are rejected, as are
embedded URL credentials. No cookies, authorization headers or proxy environment
settings are used.

The tool negotiates Markdown, text, HTML or JSON. HTML is extracted locally
with Readability and Turndown, retaining resolved relative links. Other supported
text and JSON responses are returned directly. It does not run JavaScript or
load page subresources. Downloads use identity encoding and reject unexpected
compression. Binary content requires another tool, such as `read-pdf`.

Downloads are limited to 5 MiB and five redirects. `timeout` defaults to 30000
milliseconds and can be raised to 120000. The deadline and cancellation cover
DNS, redirects and response bodies. HTML extraction has a 30,000-element limit;
its synchronous parsing cannot be preempted, so the deadline is checked afterward.

### Optional web-fetch-hosted

Set `PI_WEB_HOSTED_FETCH=1` in the **process environment** before starting Pi to
register this separate tool. It explicitly sends a public URL to Exa's
`web_fetch_exa`, with Firecrawl's `firecrawl_scrape` as the limited fallback
under the same rules as search. `provider` selects an explicit retry.

Use it only when disclosing the URL to a third party is appropriate. Local fetch
never invokes it. The initial URL and local DNS answers are validated before
submission, but the hosted provider controls subsequent DNS, redirects and
browser behavior. Results may come from provider caches; no freshness guarantee
is exposed. Exa extraction requests up to 100,000 characters per page.

### developer-search and budget

Developer Search retains the direct Firecrawl `/v2/search/developer` endpoint,
which works anonymously. Use it for external library docs, upstream issues,
merged pull requests and READMEs. Scope results with `types`, `repos` or
`sources`. Coverage reports degraded and unavailable indexes explicitly.

Only this tool resolves optional `FIRECRAWL_API_KEY`, first from the process
environment and then from `~/.pi/agent/.env`. A configured key is used for account
limits. `.env.example` documents this optional setting. Never commit credentials.

The default session budget is 20 estimated units. Each dispatched request
reserves 2 units per 10 requested results, rounded up (maximum 4). Failed
requests that reached dispatch count conservatively; local validation failures,
early cancellation and blocked requests do not. These are estimates, not billing
receipts. Anonymous units are tracked separately from estimated account credits.
The dashboard shows `Dev used/budget est` with anonymous/account attribution
when space permits. Hosted MCP requests are not included in this budget.

Interactive sessions can approve a higher budget or allow remaining requests;
headless sessions block overruns. Usage and approvals survive session reloads.
Legacy results without authentication attribution are not counted as account
spend.

### Migration

`web-research` and `web-crawl` were removed. Search no longer accepts the old
`backend` or backend-specific news/image options. Fetch is now local; old hosted
fetch parameters and reconstructed scrape caches were removed. Use the separate
opt-in hosted tool where needed. `EXA_API_KEY` is no longer read by these tools.

## Subagents

The subagent extension supports direct Pi, Claude Code and Codex runs plus
release-pinned `scout`, `lookup`, `code`, `build`, `ui`, `review`, `research` and
`write` profiles. Each profile has one primary model and no automatic fallback.
Claude and Codex require their CLIs on `PATH` and authenticated with
`claude auth` and `codex login` respectively.

Use `subagent-spawn` with `prompt`, `name` and `profile` for pinned profiles.
Use `subagent-spawn-direct` with `prompt`, `name` and `harness` when requesting
Claude, Pi, Codex or a specific model. Only the direct tool accepts optional
`model` and `reasoningEffort`. Direct execution does not inherit profile
instructions; put role, scope and constraints in its prompt.

For `review`, describe the artifact in the task or supply an explicit code-change
`reviewTarget`; omitting it does not imply uncommitted changes. Profiles load
applicable skills and author guidance. Existing harness tool access is unchanged.
See [Subagents architecture](extensions/subagents/docs/design-plan.md) for models,
guidance loading and recovery behavior.

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
