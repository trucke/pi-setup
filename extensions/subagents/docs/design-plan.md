# Subagents architecture

The extension runs autonomous, headless child sessions through three normalized backends:

- `pi`: in-process Pi SDK `AgentSession`
- `claude`: Claude Agent SDK controlling the installed Claude Code executable
- `codex`: a scoped `codex app-server` JSON-RPC process

The manager folds backend events into one snapshot model used by tools, durable artifacts, status and the takeover UI. Effect v4 owns scopes, interruption, event pumps and runtime disposal; pure parsing and rendering remain plain TypeScript.

The eight working contracts and their rationale are recorded in [Profile design](profile-design.md). OpenCode remains a future adapter, not part of this implementation.

## Public tools

- `subagent-spawn`: spawn through a release-pinned profile or direct harness settings
- `subagent-wait`: wait for all or any ids, with an optional non-cancelling timeout
- `subagent-cancel`: cancel active runs while preserving partial output
- `subagent-send`: steer or queue a message and return a delivery receipt
- `subagent-resume`: explicitly resume a recovered run
- `subagent-check`: inspect factual liveness, usage, recovery and recent output
- `subagent-list`: list runs and backend readiness

Public JSON parameters use camelCase. Profile and direct execution options are mutually exclusive. Direct execution does not inherit profile instructions. The global concurrency cap is four and remains fail-fast; there is no hidden queue.

Parent-facing tool guidance defines the routing boundaries and minimum worthwhile delegation. Prefer one child owning a coherent outcome; there is no mandatory agent pipeline.

## Execution profiles

Profiles are typed, source-controlled configuration in `src/profiles.ts`. Each has one primary model and an ordinary agent run mode.

| Profile    | Harness     | Model                       | Effort |
| ---------- | ----------- | --------------------------- | ------ |
| `scout`    | Pi          | `openai-codex/gpt-5.6-luna` | high   |
| `lookup`   | Pi          | `openai-codex/gpt-5.6-luna` | medium |
| `code`     | Pi          | `opencode-go/glm-5.3-flash` | high   |
| `build`    | Pi          | `openai-codex/gpt-6-astra`  | high   |
| `ui`       | Claude Code | `claude-fable-5-1`          | high   |
| `review`   | Pi          | `openai-codex/gpt-6-astra`  | high   |
| `research` | Pi          | `openai-codex/gpt-6-astra`  | high   |
| `write`    | Claude Code | `claude-fable-5-1`          | high   |

There is no automatic model or harness fallback. Startup errors return to the caller; asynchronous rejection settles the run as failed and closes the rejected session. The parent decides whether to retry or reassign. Historical attempt records remain readable in saved artifacts.

## Instructions and guidance

`buildProfilePrompt` composes shared working rules, the selected role and the complete task. Shared rules cover scope ownership, skills and author guidance, authorization, deliberate escalation, validation and concise handoffs. Role instructions cover their different decision authority and deliverables.

Pi discovers its normal global/package resources and trust-gated project resources in the child's working directory. Non-Pi profile runs use `src/guidance.ts` to discover the same context-file and skill locations without executing Pi extensions. The prompt tells the child to read the context files, applicable skills and referenced author guidance. Skill descriptions marked as not model-invocable are omitted from this index. Direct runs retain their existing native resource behavior.

Guidance is not copied from the parent's conversation. Personal instructions remain in personal configuration rather than being embedded in this package. Actual compliance with reading guidance and performing visual inspection still needs representative live validation.

## Review scope

`review` assesses code, plans, interfaces or documents. With no `reviewTarget`, the task prompt defines the artifact; it does not default to a Git diff. Explicit code-change targets support uncommitted changes, base branches, commits and pull requests.

`src/review.ts` renders target instructions for ordinary agent runs, native adapters and recovery. Both native and artifact-based continuation retain the recorded target. The Codex native review and Claude direct code-review modes remain internal adapter capabilities; no new profile is coupled to them.

Reviews never apply fixes or post remote comments. These are prompt restrictions, not access controls.

## Tool access and trust

Tool access is unchanged. Pi excludes nested subagent tools and `ask-user`; Claude disables internal Agent/Task delegation. This redesign adds no per-profile allowlists, MCP filtering or sandbox.

Use trusted working directories. Codex fails closed when Pi marks a target project untrusted because app-server project configuration cannot be safely disabled; Pi and Claude suppress project-scoped dynamic configuration through their native trust controls.

Browser work uses the `playwright-cli` skill and its host-managed Chromium configuration. Children must inspect screenshots and rendered output, not merely run capture commands. Browser setup and model-specific visual behavior require separate live validation.

## Lifecycle and liveness

Terminal states remain `running | done | failed | cancelled`.

Snapshots expose factual `startedAt`, `lastActivityAt`, `lastEvent` and `currentTools` fields without stall heuristics. Run deadlines and a future `timed-out` state remain deferred. Cancelling a wait never cancels child work.

Backends return one of three steering dispositions:

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

Files are bounded by the manager's transcript/output limits and created with user-only permissions. The newest 64 settled runs are retained; active-run artifacts are never pruned. Receipts record the requested profile, selected execution settings, metadata, usage and recovery mode. Historical profile identifiers and candidate attempts remain readable without becoming valid new spawn options. New runs omit candidate attempts; older releases that require that field cannot restore these new snapshots.

Restoration is scoped to the same parent Pi session id. Runs are rediscovered after restart or reload but never resume automatically. Recovery uses the recorded prompt and execution settings, not today's profile definition.

`subagent-resume` prefers native continuation:

- Pi reopens the child session file.
- Claude resumes the native Claude session id.
- Codex calls `thread/resume` for the recorded thread id.

If no native session exists but partial output does, an explicit artifact-based continuation starts a new backend session and labels the recovery mode accordingly. `mode: "continuation"` deliberately bypasses a stale native session id after a clean native-resume failure. Review targets are carried into the continuation instructions independently of the bounded previous output.

## Backend readiness

Readiness is explicit and visible through `subagent-list`:

- Pi checks model existence and configured provider authentication before creating a child session.
- Claude checks the executable and `claude auth status`.
- Codex checks the executable and `codex login status`.

Readiness probes are bounded and cached briefly. A failed readiness check does not select another provider.
