# Setup

Install the package globally at a reviewed tag or commit:

```sh
pi install git:github.com/trucke/pi-setup@v0.1.0
```

Pi clones the package into its managed git package directory and installs the
root runtime dependencies. Do not clone this repository over `~/.pi/agent`.

## Firecrawl

The package registers `firecrawl_search`, `firecrawl_scrape`, and
`firecrawl_crawl`. They resolve `FIRECRAWL_API_KEY` in this order:

1. Process environment
2. Infisical project configured at `~/.pi/agent`
3. `~/.pi/agent/.env`

For the file fallback, copy `.env.example` to `~/.pi/agent/.env` and replace the
placeholder. Never commit the resulting file.

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
