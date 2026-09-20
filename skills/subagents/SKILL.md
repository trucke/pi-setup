---
name: subagents
description: Delegate substantial or independent work to headless subagents, select a profile and manage their runs. Use when asked to use subagents or when planning a delegation.
---

# Subagents

Each child is headless, has its own context window and cannot see the parent conversation or ask the user. Give it a self-contained task with paths, constraints, acceptance criteria and the expected deliverable.

Delegate when isolation, parallel work, sustained investigation or independent assessment justifies the handoff. Keep trivial work with the parent. Prefer one child owning a coherent outcome over a routine research → writing → review pipeline.

At most four runs can be active. The cap is fail-fast; there is no hidden queue. Results return automatically, so continue useful parent work instead of immediately waiting.

## Choose the spawn tool

- **Named role, no requested harness/model:** use `subagent-spawn` with `profile`. The profile fixes its harness, model, effort and role instructions.
- **User asks for Claude, Pi, Codex or a specific model:** use `subagent-spawn-direct` with `harness`. Put the role and constraints in `prompt`, not in a `profile` field.

Both tools return the same run ids and use the same wait, check, send, cancel and resume tools. The four-run cap is shared.

## Profiles

| Profile    | Purpose                                                                         | Primary                        |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `scout`    | Explore local code and material without edits; explain findings and constraints | Pi · GPT-5.6 Luna · high       |
| `lookup`   | Verify bounded external questions using authoritative, current sources          | Pi · GPT-5.6 Luna · medium     |
| `code`     | Implement scoped changes within established architecture                        | Pi · GLM-5.3-Flash · high      |
| `build`    | Own substantial engineering decisions and implementation                        | Pi · GPT-6 Astra · high        |
| `ui`       | Own interface design, implementation and browser validation                     | Claude Code · Fable 5.1 · high |
| `review`   | Independently assess code, plans, interfaces or documents                       | Pi · GPT-6 Astra · high        |
| `research` | Investigate substantial questions through the analytical deliverable            | Pi · GPT-6 Astra · high        |
| `write`    | Draft and refine prose while preserving established substance                   | Claude Code · Fable 5.1 · high |

`subagent-spawn` requires `prompt`, `name` and `profile`. It does not accept `harness`, `model` or `reasoningEffort`; use `subagent-spawn-direct` to choose those settings.

Each profile has one primary model. There are no automatic fallbacks. A failed run reports its error and available partial work; the parent decides whether to retry or reassign. Do not silently launch another writer after a failure.

### Routing boundaries

- `scout` explores local material; `lookup` handles bounded external investigations; `research` owns substantial investigation and evidence-backed conclusions. A single search usually needs no child.
- `code` implements settled decisions; `build` makes consequential engineering decisions. Task length alone does not decide. `code` returns findings when the task outgrows its scope.
- `ui` owns interface quality, including ordinary state and local wiring. Mechanical frontend changes can go to `code`; difficult underlying engineering goes to `build`.
- `write` expresses an established argument; `research` develops it. Research can produce finished prose without a separate writing pass.
- `review` assesses existing work without applying fixes. Independent review is useful when warranted, not mandatory after every task.

### Child working rules

Profile prompts include shared scope, authorization, escalation and handoff rules. Children must read applicable skills and author guidance, perform appropriate checks and report what remains unverified. Profiles do not replace domain skills. Children report unrelated discoveries without acting on them.

Pi discovers resources for the child's working directory. Non-Pi profile runs receive context-file and skill locations discovered with Pi's resource loader, with instructions to read the relevant files. The parent conversation and previously read guidance are not inherited. Personal writing guidance stays outside this package.

For browser work, children load `playwright-cli`, use an isolated named session, inspect rendered output and screenshots, then clean up their own session. A screenshot command alone is not visual validation.

Role restrictions are instructions, not a sandbox. Existing harness tool access is unchanged; use trusted working directories. Codex refuses targets Pi marks untrusted; Pi and Claude suppress project-scoped dynamic configuration through their native trust controls.

Example:

```text
subagent-spawn({
  prompt: "Inspect the parser and identify the likely race. Report paths and evidence; do not edit.",
  name: "parser race scout",
  profile: "scout",
  workingDir: "/trusted/repo"
})
```

## Direct execution

`subagent-spawn-direct` requires only `prompt`, `name` and `harness`. It has no `profile` or `reviewTarget` fields. Direct execution does not inherit a profile contract; include the role, authorization limits, required guidance and expected output in the task.

For example, when asked for a Claude evaluation:

```text
subagent-spawn-direct({
  prompt: "Read-only evaluation of /trusted/repo. Read its repository instructions, compare the web-search design with the supplied upstream sources and report evidence-backed simplifications. Do not edit, publish or make paid API calls.",
  name: "Claude web-search evaluation",
  harness: "claude",
  workingDir: "/trusted/repo"
})
```

Omit `model` and `reasoningEffort`, or set them to `null`, unless a particular setting is needed. Optional fields accept `null` for transports that require every property. `workingDir: null` uses the parent's directory. Do not fill unused fields with empty strings or placeholder values. Model formats: Pi uses `provider/model-id`, Claude accepts a model alias/id and Codex accepts a model slug.

Harnesses:

- `pi`: in-process Pi session; omitted model/effort inherit the parent in direct mode
- `claude`: Claude Code; requires the installed CLI to be authenticated; omitted model/effort use Claude defaults
- `codex`: Codex app-server; requires `codex login`; omitted model/effort use Codex defaults

Reasoning efforts follow `off < minimal < low < medium < high < xhigh < max`. Supported effort levels and their meaning depend on the model and harness.

## Review targets

With `subagent-spawn`, use `profile: "review"`. Describe the exact document, plan, interface or other artifact in `prompt`; omit `reviewTarget` or set it to `null` for those tasks and for every non-review profile. Only code-change reviews need an optional explicit target:

```text
reviewTarget: { type: "uncommittedChanges" }
reviewTarget: { type: "baseBranch", branch: "main" }
reviewTarget: { type: "commit", sha: "<sha>" }
reviewTarget: { type: "pullRequest", number: 123 }
```

Supply only the fields relevant to that target. Omitting `reviewTarget` does not imply uncommitted changes. Reviews do not apply fixes, commit or post remote comments. Explicit targets survive both native and artifact-based recovery.

For a review on a requested harness, use `subagent-spawn-direct` and describe the exact review target and read-only constraints in `prompt` instead.

## Handle failures

Do not repeat a failed call unchanged. Argument errors identify the correction or the other spawn tool to use. If a backend cannot start, inspect `subagent-list` readiness and report the blocker rather than silently changing the requested harness/model. If a run id was returned, inspect it with `subagent-check` before creating another run.

## Manage runs

- `subagent-check({ id })`: factual liveness, current tools, usage, recovery and recent output
- `subagent-list()`: tracked/recovered runs and backend readiness
- `subagent-send({ id, message })`: steer or continue; returns `delivered`, `queued` or `unsupported`
- `subagent-wait({ ids, mode: "all" | "any", timeoutMs? })`: wait without cancelling work on timeout or abort
- `subagent-cancel({ ids })`: cancel while preserving partial output and artifacts
- `subagent-resume({ id, prompt, mode? })`: explicitly resume a recovered run; use `mode: "continuation"` to bypass a stale native session id; recovery is never automatic
- `/subagents`: inspect or take over a run interactively
- `/btw`: ask a one-off side question outside model-facing tooling

Durable receipts, snapshots, normalized JSONL transcripts and Markdown output are stored in Pi-managed user state and rediscovered only for the same parent Pi session. Historical profile names remain readable; recovery preserves the recorded task instead of applying a renamed role's new instructions.
