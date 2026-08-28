---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, and cannot ask the user. Give every child a self-contained prompt with paths, constraints, and the expected report.

At most four runs can be active. The cap is fail-fast; there is no hidden queue. Results return automatically, so continue useful parent work instead of immediately waiting.

## Profiles

Prefer a profile when its role fits:

| Profile    | Purpose                                        | Candidate order                                                                                    |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `scout`    | Inspect and map a repository without edits     | Pi · GLM 5.3 Flash · high; Pi · GPT-5.6 Luna · xhigh                                               |
| `worker`   | Implement focused changes                      | Claude Code · Fable 5 · medium; Pi · GPT-5.6 Sol · high; Pi · GLM 5.3 Flash · high                 |
| `reviewer` | Review changes without modifying or commenting | Codex · GPT-5.6 Sol · high · native review; Claude Code · Fable 5 · high · direct read-only review |
| `oracle`   | Deep technical analysis and recommendations    | Pi · GPT-5.6 Sol · xhigh; Pi · GLM 5.3 Flash · high                                                |

Profile fallbacks are explicit and occur only before meaningful model or tool activity. Typed asynchronous startup rejection can advance to the next candidate under the same run id; every attempt is recorded. Fallback never launches a second writer after a workspace may have been mutated.

Scout and reviewer inspect-only behavior is prompt guidance, not a sandbox boundary. Every profile still has the harness's normal host permissions, so use only trusted working directories. Codex refuses targets Pi marks untrusted; Pi and Claude suppress project-scoped configuration through their native trust controls.

Example:

```text
subagent-spawn({
  prompt: "Inspect the parser and identify the likely race. Report paths and evidence.",
  name: "parser race scout",
  profile: "scout",
  workingDir: "/trusted/repo"
})
```

## Direct execution

Use direct execution only when a specific harness/model is required. `profile` is mutually exclusive with `harness`, `model`, and `reasoningEffort`.

```text
subagent-spawn({
  prompt: "Implement the prepared change and run focused tests.",
  name: "implementation",
  harness: "pi",
  model: "openai-codex/gpt-5.6-sol",
  reasoningEffort: "high",
  workingDir: "/trusted/repo"
})
```

Harnesses:

- `pi`: in-process Pi session; omitted model/effort inherit the parent in direct mode
- `claude`: Claude Code; requires the installed CLI to be authenticated
- `codex`: Codex app-server; requires `codex login`

Reasoning efforts follow:

```text
off < minimal < low < medium < high < xhigh < max
```

## Reviewer targets

The reviewer defaults to uncommitted changes. Other targets are explicit:

```text
reviewTarget: { type: "baseBranch", branch: "main" }
reviewTarget: { type: "commit", sha: "<sha>" }
reviewTarget: { type: "pullRequest", number: 123 }
```

Reviews do not post comments or apply fixes by default.

## Manage runs

- `subagent-check({ id })`: factual liveness, current tools, usage, recovery, and recent output
- `subagent-list()`: tracked/recovered runs and backend readiness
- `subagent-send({ id, message })`: steer or continue; returns `delivered`, `queued`, or `unsupported`
- `subagent-wait({ ids, mode: "all" | "any", timeoutMs? })`: wait without cancelling work on timeout or abort
- `subagent-cancel({ ids })`: cancel while preserving partial output and artifacts
- `subagent-resume({ id, prompt, mode? })`: explicitly resume a recovered run; use `mode: "continuation"` to bypass a stale native session id; recovery is never automatic
- `/subagents`: inspect or take over a run interactively
- `/btw`: ask a one-off side question outside model-facing tooling

Durable receipts, snapshots, normalized JSONL transcripts, and Markdown output are stored in Pi-managed user state and rediscovered only for the same parent Pi session.
