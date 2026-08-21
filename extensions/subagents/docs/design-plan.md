# Subagents architecture

The extension runs autonomous, headless child sessions through three normalized backends:

- `pi`: in-process Pi SDK `AgentSession`
- `claude`: Claude Agent SDK controlling the installed Claude Code executable
- `codex`: a scoped `codex app-server` JSON-RPC process

The manager folds backend events into one snapshot model used by tools, durable artifacts, status, and the takeover UI. Effect v4 owns scopes, interruption, event pumps, and runtime disposal; pure parsing and rendering remain plain TypeScript.

## Public tools

- `subagent-spawn`: spawn through a release-pinned profile or direct harness settings
- `subagent-wait`: wait for all or any ids, with an optional non-cancelling timeout
- `subagent-cancel`: cancel active runs while preserving partial output
- `subagent-send`: steer or queue a message and return a delivery receipt
- `subagent-resume`: explicitly resume a recovered run
- `subagent-check`: inspect factual liveness, usage, recovery, and recent output
- `subagent-list`: list runs and backend readiness

Public JSON parameters use camelCase. Profile and direct execution options are mutually exclusive. The global concurrency cap is four and remains fail-fast; there is no hidden queue.

## Execution profiles

Profiles are typed, source-controlled configuration in `src/profiles.ts`.

| Profile    | Candidate order                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `scout`    | Pi · `openai-codex/gpt-5.6-luna` · xhigh; Pi · `opencode-go/deepseek-v4-pro` · high                   |
| `worker`   | Claude · Fable 5 · medium; Pi · Kimi K3 · max; Pi · GPT-5.6 Sol · high                                |
| `reviewer` | Codex · GPT-5.6 Sol · high · native `review/start`; Claude · Fable 5 · high · direct read-only review |
| `oracle`   | Claude · Fable 5 · high; Pi · GPT-5.6 Sol · high                                                      |

A profile fallback is attempted when backend readiness/session creation fails or when a backend emits a typed startup rejection before meaningful activity. Asynchronous fallback keeps the same run id, closes the rejected candidate first, and records every attempt. The first assistant delta/message or tool event locks the selected candidate; later failures are terminal and never launch a second writer.

The reviewer defaults to uncommitted changes and supports base branches, commits, and pull requests. Reviews never post comments or apply fixes unless a separate explicit task requests that behavior. Claude uses a direct target-aware review prompt rather than its PR-oriented `/code-review` command because that command may post remote comments; internal Agent/Task tools remain disabled.

Scout/reviewer inspect-only behavior is prompt guidance, not an access-control boundary. Explicit sandbox/access modes are intentionally out of scope for this release, so all profiles must still be launched only in trusted working directories. Codex fails closed when Pi marks a target project untrusted because app-server project configuration cannot be safely disabled; Pi and Claude suppress project-scoped configuration through their native trust controls.

## Lifecycle and liveness

Terminal states are explicit:

```text
running | done | failed | cancelled
```

Snapshots expose factual fields without stall heuristics:

```text
startedAt
lastActivityAt
lastEvent
currentTools
```

Run deadlines and a future `timed-out` state are intentionally deferred. Cancelling a wait never cancels child work.

## Steering

Backends return one of three dispositions:

- `delivered`: accepted by the active or newly started backend turn
- `queued`: retained for a later turn
- `unsupported`: the tracked artifact is not currently attached to a live session

The extension never silently restarts a child to deliver steering.

## Durable artifacts and recovery

Each run writes atomically under Pi-managed user state:

```text
~/.pi/agent/state/subagents/<run-id>/
├── receipt.json
├── snapshot.json
├── transcript.jsonl
└── output.md
```

Files are bounded by the manager's transcript/output limits and created with user-only permissions. The newest 64 settled runs are retained; active-run artifacts are never pruned. Receipts record the requested profile, selected candidate, all unavailable candidates, effective harness/model/effort/run mode, metadata, usage, and recovery mode.

Restoration is scoped to the same parent Pi session id, preventing unrelated projects or sessions from seeing each other's run metadata. Runs are rediscovered after restart or reload but never resume automatically.

`subagent-resume` prefers native continuation:

- Pi reopens the child session file.
- Claude resumes the native Claude session id.
- Codex calls `thread/resume` for the recorded thread id.

If no native session exists but partial output does, an explicit artifact-based continuation starts a new backend session and labels the recovery mode accordingly. `subagent-resume` also accepts `mode: "continuation"` so a user can deliberately bypass a stale native session id after a clean native-resume failure.

## Backend readiness

Readiness is explicit and visible through `subagent-list`:

- Pi checks model existence and configured provider authentication before creating a child session.
- Claude checks the executable and `claude auth status`.
- Codex checks the executable and `codex login status`.

Readiness probes are bounded and cached briefly. Profiles cross providers only through their declared candidate list; there is no implicit provider fallback.
