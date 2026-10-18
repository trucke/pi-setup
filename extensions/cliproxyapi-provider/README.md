# CLIProxyAPI provider

Connects Pi to a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) server for GPT and Claude models.
GPT models use CPA's Responses WebSocket and continue earlier turns instead of resending the whole conversation.
Claude models use Anthropic Messages. OpenCode and OpenCode Go stay Pi's built-in providers.

The extension does nothing until its config file exists.

## Set up

1. Create `~/.pi/agent/cliproxyapi.json` (or `$PI_CODING_AGENT_DIR/cliproxyapi.json`):

   ```json
   { "baseUrl": "http://127.0.0.1:8317" }
   ```

2. Provide a CPA client key. Either set `CLIPROXYAPI_API_KEY` in Pi's environment or run `/login cliproxyapi`.
   A stored key can be a secret command such as `"!security find-generic-password -ws cpa"`.
3. Start Pi and run `/proxy status`. You should see `ready`, the key source and the number of models.
   Run `/proxy models` to see the model table and metadata warnings.

On the first start without a cached model list, Pi asks CPA once, for at most 8 seconds, using the environment key.
Later starts use the cached list immediately. TUI and RPC sessions check it in the background on startup and `/reload`, including when the key is stored as a secret command. The automatic check has an 8-second deadline and keeps cached models if it fails.
Print and JSON runs use the cache without contacting CPA. `/proxy refresh` forces a check when you want one; it is not required during normal interactive use.

## Move from a manual `proxy` provider in models.json

The extension refuses to register a provider id that `models.json` still defines with `models`, `baseUrl`, `api` or `oauth`.
`/proxy status` names the conflict. To keep the name `proxy`:

1. Remove the `providers.proxy` block from `~/.pi/agent/models.json`. A block with only `modelOverrides` can stay.
2. Set `"provider": "proxy"` in `cliproxyapi.json`.
3. Move per-model corrections into `routes`, for example:

   ```json
   {
     "baseUrl": "https://cpa.example",
     "provider": "proxy",
     "routes": {
       "gpt-6.1-sol": { "contextWindow": 500000 },
       "gpt-6.1-sol-fast": { "metadata": "openai/gpt-6.1-sol", "contextWindow": 500000 }
     }
   }
   ```

4. Run `/reload`, then `/proxy refresh`.

Model ids stay exactly as CPA lists them, including aliases such as `gpt-6.1-sol-fast`.

## Configuration reference

`PI_CLIPROXYAPI_CONFIG` overrides the config file path. Unknown keys are rejected.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | required | CPA root URL. A trailing `/v1` is accepted. |
| `provider` | `cliproxyapi` | Pi provider id. Built-in provider ids are refused. |
| `name` | `CLIProxyAPI` | Display name. |
| `apiKeyEnv` | `CLIPROXYAPI_API_KEY` | Environment variable that holds the client key. The file never holds the key itself. |
| `websocket` | `true` | `false` sends GPT requests over HTTP streaming (SSE) only. |
| `routes` | `{}` | Settings per CPA model id, described below. |

A route can set:

| Key | Meaning |
|---|---|
| `api` | `openai-responses` or `anthropic-messages`. Required for ids that are not inferred. |
| `metadata` | Pi catalog entry to enrich from, such as `openai/gpt-6.1-sol`. `null` turns enrichment off. |
| `name`, `contextWindow`, `maxTokens`, `input`, `reasoning`, `thinkingLevelMap`, `cost` | Corrections with Pi's model field meanings. |
| `compat` | Pi compatibility flags for the route's API, such as `supportsMidConvoEffort`. |

## Model list and metadata

CPA decides which models exist. Pi asks `GET /v1/models` and, for details, `GET /v1/models?client_version=pi`, which older CPA versions do not support.

Without a route, only bare ids are used: `gpt-*` with Responses and `claude-*` with Anthropic Messages.
Other ids, such as `go/claude-haiku-5-5`, are hidden and listed in `/proxy models`.

Each field takes the first available source:

| Field | GPT routes | Claude routes |
|---|---|---|
| Context window | route, CPA, Pi catalog | route, then CPA or Pi catalog (the smaller when both exist) |
| Max output, input types, reasoning levels | route, CPA, Pi catalog | route, Pi catalog |
| Price | route, Pi catalog | route, Pi catalog |

CPA reports GPT-style details even for Claude ids it knows little about, so they are not trusted there.
Conflicting context sizes appear as warnings in `/proxy models`.

Metadata comes from Pi's own model catalog: the session catalog including pi.dev updates, or the catalog bundled with Pi.
There is no separate models.dev download. The default entry is `openai/<id>` for GPT and `anthropic/<id>` for Claude.
Fields that no source provides stay conservative: text only, no reasoning, 128000 context, 16384 output and price 0.
This is common for aliases without a catalog entry. `/proxy models` warns about unverified default limits. A price of 0 does not mean free, and catalog prices are estimates, not CPA billing.

From a catalog entry, only flags describing the request shape are taken, such as strict tools and adaptive thinking.
Mid-conversation features such as `configuration_update` stay off unless a route enables them in `compat`.

## Cache

The model list is stored in Pi's `models-store.json` under the provider id, with the CPA root and a scrypt hash of the key.
The key itself is not stored. A cached list is used only for the same CPA root.
It is also checked against the key when Pi can read the key without running a command.

## WebSocket continuation

For GPT models in a session, Pi's normal Responses request is carried over `wss://<root>/v1/responses`.
When a request extends the previous one on the same connection, only the new input is sent with `previous_response_id`.
Pi keeps the full history. Continuation only saves sending it again.

- A continuation is sent only when the request options are identical and the new input starts with the previous input and that response's output, item for item.
- Anything else, including compaction, `/tree` navigation, edited history and model changes, starts a full request on a new connection.
- Connections belong to one session, model and key. Parallel and subagent sessions never share them.
- If CPA rejects a continuation, or closes with code 1012 to ask for a replay, the full history is sent once on a new connection.
- If the WebSocket cannot connect, the same request goes over HTTP and the session stays on HTTP for 5 minutes.
- If a reused connection is lost before the request was sent, the full history goes over a new connection.
- If CPA may have received a request, the extension reports the failure instead of resending it. Pi's own retry policy still applies.
- Idle connections close after 5 minutes. Aborts, `/reload` and session shutdown close them.
- Pi's `transport: "sse"` setting, a model with a different `baseUrl`, and requests without a session id use HTTP.

Request hooks work as usual. For WebSocket requests, `onResponse` sees a synthetic `200 text/event-stream` response, not the handshake headers.

Continuation applies between Pi and CPA. How CPA reaches the upstream service is CPA's decision.
For HTTP upstreams, CPA expands each continuation back to the full history.

## Commands

- `/proxy status`, or `/proxy` alone, shows an aligned status snapshot: `checking` while the background check runs, `ready` after verification, `cached` when showing a saved model list, `refresh failed` after an unsuccessful check or `not ready` when the key or models are missing.
  The command itself does not contact CPA. A visible status snapshot updates when the automatic check finishes. It counts metadata notices, config warnings and hidden ids without listing them. Metadata notices, such as a missing price, do not make the provider unhealthy.
  `idle` means this session has not sent a GPT request yet; the WebSocket opens on the first one.
- `/proxy models` shows an aligned table, one row per model, with API, token limits, input types, reasoning support and note references. Narrow terminals omit optional columns and shorten long model ids. Shared metadata warnings appear once below the table, followed by config warnings and hidden ids.
- `/proxy refresh` immediately shows a notification, then reports success, failure or timeout. Failed refreshes keep the previous list. A second refresh while one is running reports that it is already in progress. Neither automatic checks nor manual refreshes add a footer line.

Without an interactive UI, the commands write to stderr.

## Limitations

- First-use discovery before model selection needs the key in the environment. If there is no cached catalog yet and the key is only stored, Pi needs another available model to finish startup before the background check can discover CPA models.
- `pi update --models` does not load extensions, so it does not refresh this provider.

## Development

`pnpm test` covers this extension. `pnpm test:cli` stages the package with runtime dependencies only and runs it under the installed `pi` binary; set `PI_BIN` to use another one.
