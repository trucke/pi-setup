# Subagent profile design

Status: **Implemented in source; live validation pending.** Updated: 2026-09-19.

This document records the eight-profile design. The implementation is described in [Subagents architecture](design-plan.md), with executable configuration in [profiles.ts](../src/profiles.ts). Installed behavior changes only after release and deployment.

## Profiles

The design has eight profiles. `research` absorbs the former `analyst` responsibilities. `lookup` remains provisionally separate from `scout`; consolidate them later if delegated external investigations do not justify the distinction.

Each profile has one primary model and no automatic fallback. **GLM-5.3-Flash · high is the selected `code` model for now.** Model assignments remain subject to practical evaluation, not claims of measured superiority.

Model shorthand: Astra means GPT-6 Astra, Luna means GPT-5.6 Luna, Sol means GPT-5.6 Sol and Fable means Claude Fable 5.1. Each model is followed by its requested reasoning effort. These are display labels; exact provider configuration strings are recorded in the architecture document and executable configuration.

| Profile      | Primary model            | Description                                                                                                      | When to use                                                                                                                                            |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **scout**    | **Luna · high**          | Explore existing code and local material; explain relevant findings and constraints.                             | Locate an implementation, trace a dependency, map a subsystem or find relevant knowledge-vault notes.                                                  |
| **lookup**   | **Luna · medium**        | Find and verify bounded external information using authoritative, current sources.                               | Investigate compatibility across libraries, verify version-specific API behavior or answer a bounded external question substantial enough to delegate. |
| **code**     | **GLM-5.3-Flash · high** | Implement well-defined small and medium tasks within established architecture.                                   | Fix a localized bug, add an endpoint following established patterns, write a script or perform a scoped refactor with clear acceptance criteria.       |
| **build**    | **Astra · high**         | Own substantial engineering decisions and implementation.                                                        | Design APIs or architecture, make database decisions, resolve complex bugs or deliver features across multiple subsystems.                             |
| **ui**       | **Fable · high**         | Own interface design, implementation and browser-based validation.                                               | Build a screen or component, improve a user flow, establish visual direction or fix responsive and accessibility issues.                               |
| **review**   | **Astra · high**         | Independently assess artifacts using task-specific criteria.                                                     | Review code, architecture, plans or documents for defects, omissions, unsupported assumptions and maintainability problems.                            |
| **research** | **Astra · high**         | Investigate substantial questions and produce evidence-backed findings, recommendations or analytical documents. | Compare approaches, reconcile conflicting evidence, develop scientific sections or produce technical assessments and funding arguments.                |
| **write**    | **Fable · high**         | Draft and refine prose while preserving established substance.                                                   | Write correspondence, documentation, website copy or narrative text; polish scientific prose when its argument and evidence are already settled.       |

Profiles define responsibilities and authority, not merely model presets. Sharing a model does not make distinct working contracts redundant.

## Delegation and routing

- **Delegate only when useful.** Isolation, parallel work, sustained investigation or independent assessment should justify the handoff. Keep trivial work with the parent when explaining the context costs more than doing it directly. A single search or documentation fetch usually does not need a child.
- **Prefer end-to-end ownership.** Assign one child a coherent outcome. Split work only for useful parallelism, materially different authority or independent review. There is no routine research → writing → review pipeline.
- **scout / lookup / research:** Use `scout` for existing local material, `lookup` for bounded external investigations and `research` for substantial investigation, evidence evaluation and analytical deliverables.
- **code / build:** Use `code` for implementation within settled decisions and `build` when significant engineering judgment is required. Task length alone does not decide. `build` owns both decisions and implementation; a separate architecture-only profile is not needed.
- **write / research:** Use `write` to express an established argument and `research` to develop and substantiate it. Scientific prose editing can belong to `write`; an analytical business document can belong to `research`. `research` should deliver readable finished work without requiring a separate writing pass.
- **ui / code / build:** Use `ui` when interface quality is central. A small mechanical frontend change can go to `code`; a difficult underlying engineering problem can go to `build`. Ordinary component state and local wiring remain within `ui` ownership.
- **review:** Use for independent assessment of an existing artifact. Implementation and revision belong to the relevant producing profile. Review is not mandatory after every task.

## Shared working rules

- **Own the delegated scope.** Respect assigned files and concurrent work; avoid unrelated cleanup. Report out-of-scope discoveries without acting on them.
- **Investigate before asking.** Resolve ordinary details through code, documentation and existing conventions.
- **Finish the work.** Include appropriate validation and address failures caused by the change.
- **Respect action boundaries.** Editing does not authorize deployment, publication or changes to live data. Tool availability does not expand authorization.
- **Load applicable guidance.** Discover and read the relevant skills and author guidance. A profile does not replace a domain skill: `build` working on dotfiles still needs the dotfiles skill. Do not assume children inherit guidance or skills already read by the parent.
- **Return a concise handoff.** Report the outcome, relevant changes, validation results and unresolved issues. For blocked work, explain the specific decision needed.
- **Distinguish validation levels.** State what was checked and what remains unverified. Self-checks are not independent verification, particularly for citations, scientific claims and consequential documents.
- **Escalate deliberately.** Return findings and recommend reassignment when necessary. The parent decides; children do not silently launch replacements or upgrade models.

## Agreed contracts: code and build

| Detail               | `code`                                                                                                                  | `build`                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Implement a bounded change within established architecture.                                                             | Handle substantial engineering tasks through decisions and implementation.                                          |
| Typical tasks        | Localized fixes, scripts, endpoints following existing patterns and scoped refactors.                                   | API design, database changes with migration trade-offs, difficult debugging and features spanning subsystems.       |
| Expected input       | Desired behavior, relevant context, constraints and clear acceptance criteria.                                          | Problem, desired outcome, constraints and any decisions already made. The solution can remain open.                 |
| Decision authority   | Choose implementation details and follow existing patterns.                                                             | Investigate alternatives and make engineering decisions within the delegated scope.                                 |
| Tools                | Read, search, edit, run commands and tests; retrieve relevant documentation.                                            | Same capabilities, with broader investigation as needed.                                                            |
| Validation           | Run focused checks that demonstrate the requested behavior.                                                             | Validate the solution across affected boundaries, including integration or migration concerns where relevant.       |
| Stop and return when | Completion requires an architectural decision, materially broader changes or missing requirements that affect behavior. | Completion requires a product decision, additional authorization or information that cannot reasonably be inferred. |

When `code` reaches a consequential design decision, it returns its findings and recommends reassignment to `build`. Ordinary local choices, such as extracting a helper or selecting an existing utility, remain its responsibility.

| Task                                                                    | Route   |
| ----------------------------------------------------------------------- | ------- |
| Add pagination using the repository's established pagination contract.  | `code`  |
| Decide the pagination contract and implement it across API and clients. | `build` |
| Fix a bug with a known cause and bounded impact.                        | `code`  |
| Investigate intermittent data corruption across services.               | `build` |

## Agreed contracts: scout, lookup and research

| Detail               | `scout`                                                                                                | `lookup`                                                                                               | `research`                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Purpose              | Find and explain relevant existing code or local material.                                             | Find and verify bounded external information.                                                          | Investigate substantial questions and produce evidence-backed findings, recommendations or analytical documents.                                                                                             |
| Typical tasks        | Trace a code path, map a subsystem, locate decisions or project notes.                                 | Investigate official documentation, compatibility or version-specific behavior.                        | Compare approaches, evaluate evidence, develop arguments and methodology or produce scientific and business analyses.                                                                                        |
| Expected input       | Question or investigation target, relevant locations and scope.                                        | Specific question and any version, date, region or other constraint.                                   | Question, requested deliverable, intended use, constraints, desired depth and any settled decisions or supplied evidence.                                                                                    |
| Decision authority   | Explain observed behavior and relevant constraints.                                                    | Establish what sources verify and identify remaining uncertainty.                                      | Evaluate evidence, challenge assumptions and develop arguments or recommendations within the delegated scope.                                                                                                |
| Tools                | Local file search, reading and non-mutating inspection commands.                                       | Web search and retrieval; local context where needed to frame the question.                            | Local and external search, document retrieval, calculations, data analysis and small isolated experiments; edit requested deliverables.                                                                      |
| Source requirements  | Cite file paths and relevant lines or document sections. Distinguish observed behavior from inference. | Prefer authoritative sources. Match the requested version and context; check freshness where relevant. | Prefer primary sources. Assess relevance, quality and limitations; corroborate consequential claims where possible.                                                                                          |
| Validation           | Check that the explanation follows from the inspected material.                                        | Check source authority, freshness and applicability to the question.                                   | Check whether evidence supports claims, calculations hold and conclusions follow. Check deliverable requirements and preserve uncertainty.                                                                   |
| Output               | Direct answer with relevant code flow, constraints, references and gaps, not just matching paths.      | Direct answer with source links and necessary qualifications.                                          | Requested findings or finished analytical deliverable, with traceable evidence, assumptions, limitations and recommendations when requested.                                                                 |
| Stop and return when | The question is answered, relevant material is exhausted or access is missing.                         | The fact is verified, cannot be verified or turns out to require substantial investigation.            | The agreed depth is reached, further investigation adds little or completion requires missing evidence, authorization or a consequential user decision. Complete useful independent sections where possible. |

### Investigation rules

- **Preserve source material.** Return findings to the parent. Writing a requested report or research artifact is allowed when explicitly included in the task. `research` may also create isolated experiment artifacts under the rules below.
- **Evidence over confidence.** Separate what sources establish, what the agent infers and what remains unknown. Never invent citations or imply that an unread source was verified.
- **Search proportionately.** A specific documentation question should not become a broad survey. A substantial comparison should not end after the first plausible source.
- **Report blockers precisely.** Explain what was checked and what is missing. Recommend reassignment when needed; the parent decides.
- **Own the analytical outcome.** `research` gathers and evaluates the evidence needed for its deliverable rather than returning a separate research request merely because evidence gathering is substantial.
- **Use context directly.** `research` can inspect local context itself, and `lookup` can read local configuration to identify the correct documentation version. Neither needs a mandatory `scout` pass.

### Research experiments

Small, isolated experiments are part of `research`'s normal authority and do not require separate approval for each experiment within the delegated scope.

- **Answer a research question.** Test an API's behavior, reproduce a documented limitation, inspect a sample dataset or compare approaches with a small benchmark.
- **Keep it isolated.** Use a temporary directory or disposable environment without changing project files, shared services or live data.
- **Keep it bounded.** If the experiment requires substantial implementation, infrastructure or prolonged debugging, return the experiment specification and findings to the parent for assignment to `code` or `build`.
- **Make results reproducible.** Report the setup, versions, commands, observations and limitations. A small experiment supports a scoped conclusion, not a universal claim.
- **Respect existing authorization.** Paid resources or external changes require authorization covering that use. Existing authorization remains valid; do not request it again.

`scout` and `lookup` remain focused on inspection and retrieval.

| Task                                                                              | Profile    |
| --------------------------------------------------------------------------------- | ---------- |
| Trace how authentication middleware validates tokens across the service.          | `scout`    |
| Verify key-rotation support and constraints across the selected library versions. | `lookup`   |
| Assess key-rotation approaches and produce a recommendation for this system.      | `research` |
| Locate and explain relevant project decisions in the knowledge vault.             | `scout`    |
| Compare database approaches and write a decision document.                        | `research` |

These examples identify the profile when delegation is worthwhile; they do not require spawning a child for a trivial lookup.

## Agreed contract: write

`write` expresses and improves an established message; `research` develops the reasoning behind it.

| Detail               | `write`                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Draft and edit clear prose suited to its audience while preserving established substance.                                                                |
| Typical tasks        | Correspondence, documentation, website copy, narrative text and polishing scientific prose.                                                              |
| Expected input       | Purpose, audience, language, key points and any style or format constraints. Existing text when editing.                                                 |
| Decision authority   | Choose wording, structure, tone and emphasis while preserving meaning and factual commitments.                                                           |
| Tools                | Read source material, retrieve supporting information and edit assigned documents.                                                                       |
| Validation           | Check meaning, factual consistency, terminology, tone and requested format or length.                                                                    |
| Output               | Finished prose, with brief notes only for material assumptions or unresolved issues.                                                                     |
| Stop and return when | Missing information would force it to invent facts, commitments or the intended position. Substantial development of the argument belongs to `research`. |

### Writing and analytical deliverables

These rules apply to `write` and to documents produced by `research`.

- **Preserve the author's position.** Neither profile invents experiences, promises or beliefs. `research` may recommend a position, clearly identifying it as a recommendation.
- **Use the appropriate voice.** Follow the author's writing guidance and supplied examples. Language and audience determine register. Do not apply one author's voice to someone else's writing unless asked.
- **Keep claims traceable.** Never invent citations or imply that an unread source was verified. Preserve citation links when restructuring.
- **Resolve small gaps independently.** `write` may verify a specific fact directly. If substantial investigation or argument development is needed, return a scoped request to the parent for `research`.
- **Edit within scope.** Create or revise assigned documents. Sending, submitting or publishing requires authorization covering that action; existing authorization remains valid.

### Editorial freedom

`write` may restructure substantially when drafting or rewriting. Proofreading preserves wording and structure where possible; cleanup improves clarity without broadly reorganizing the text. All editing preserves meaning, facts, qualifications and commitments. A request to review or comment does not authorize rewriting.

When tasked with developing an analysis, `research` may challenge the supplied argument and propose a better-supported conclusion, making consequential changes explicit. When only editing an existing analysis, it preserves the substance and flags concerns separately. Neither profile silently fills factual gaps with plausible text.

### Loading author guidance

Personal configuration identifies applicable author guidance, such as a `WRITING.md` file. Keep personal preferences and examples outside this repository; profile instructions should require following the applicable guidance without copying it into every profile.

- `write` reads the guidance before drafting or editing on the author's behalf.
- `research` applies it to presentation while preserving evidence, technical precision, uncertainty and methodological detail. Required publication conventions take precedence over this guide's style defaults.
- Other profiles read it when producing prose on the author's behalf, such as documentation or PR descriptions. Routine findings and technical handoffs do not require adopting the author's voice.
- Each harness makes loading explicit. Pi discovers child resources natively; non-Pi profile runs receive context-file and skill locations with instructions to read applicable files and referenced author guidance. Do not assume the child inherits guidance read by the parent. Representative live validation of child compliance remains necessary.
- Task-specific language, audience, format and supplied author voice refine the defaults. `unslop` remains an optional editing step, not a mandatory extra pass.

| Task                                                                          | Profile    |
| ----------------------------------------------------------------------------- | ---------- |
| Improve the English of a scientific discussion without changing its argument. | `write`    |
| Develop the discussion from results and relevant literature.                  | `research` |
| Turn agreed product facts into German website copy.                           | `write`    |
| Develop a funding proposal's technical rationale and evaluation methodology.  | `research` |

## Agreed contract: ui

Primary: **Fable 5.1 · high**.

| Detail               | `ui`                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Design and implement interfaces that are clear, usable and visually coherent.                                                                                                                                  |
| Typical tasks        | Screens, components, interaction flows, responsive layouts, accessibility improvements and visual polish.                                                                                                      |
| Expected input       | User goal, relevant screens or code, constraints and any existing design system or references. State whether the deliverable is a design, implementation or both.                                              |
| Decision authority   | Choose layout, typography, spacing, component composition and interaction details within the assigned scope. Follow established product and design conventions. Own ordinary component state and local wiring. |
| Tools                | Read, search, edit, run focused checks and inspect the interface through a browser, screenshots and accessibility tools where available.                                                                       |
| Validation           | Check rendered appearance, relevant viewport sizes, keyboard interaction and applicable loading, empty, error and success states. Run focused functional checks for changed behavior.                          |
| Output               | Requested design or implemented interface, with a concise explanation of consequential decisions, validation performed and remaining limitations.                                                              |
| Stop and return when | Progress requires an unresolved product decision, a consequential backend or architectural change, or missing assets or access that prevent meaningful completion.                                             |

### UI working rules

- **Start with the existing product.** Inspect its components, styles and interactions before introducing new patterns.
- **Match design freedom to the task.** A local improvement should fit the existing system. A new interface or explicit redesign allows broader visual decisions.
- **Design the interaction, not just the screenshot.** Account for content, state changes, feedback and accessibility.
- **Inspect what was built.** Use the rendered interface when tooling permits. If visual validation is unavailable, report that limitation explicitly.
- **Keep implementation proportionate.** Reuse suitable components and avoid unnecessary dependencies or animation. Respect reduced-motion preferences.
- **Keep product decisions visible.** Do not invent business rules, promises or backend behavior to make a flow appear complete.

`ui` has authority over ordinary visual and interaction decisions without approval for each one. Escalate when a choice changes product behavior beyond the delegated scope or exceeds the design brief. For an open-ended design task, produce one coherent direction unless alternatives are requested.

| Task                                                                                | Route    |
| ----------------------------------------------------------------------------------- | -------- |
| Replace a label or wire a button to an existing handler using established patterns. | `code`   |
| Design and implement a clearer settings screen, including local state and wiring.   | `ui`     |
| Resolve a difficult synchronization problem behind that screen.                     | `build`  |
| Assess the screen independently for usability or implementation defects.            | `review` |

## Agreed contract: review

Primary: **Astra · high**.

One profile assesses different artifacts using criteria suited to the task. Separate code, UI and prose review profiles are not needed.

| Detail               | `review`                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Independently assess work and identify actionable defects, risks and omissions.                                                                    |
| Typical tasks        | Code review, architecture assessment, plan review, UI evaluation and scrutiny of analytical documents.                                             |
| Expected input       | Exact artifact or change scope, intended outcome, relevant requirements and any requested review focus.                                            |
| Decision authority   | Challenge assumptions, verify claims and recommend changes. Return findings without applying fixes.                                                |
| Tools                | Read, search, inspect diffs, retrieve sources, inspect rendered interfaces and run focused checks or isolated reproductions.                       |
| Validation           | Investigate suspected issues enough to establish their conditions and consequences. Distinguish demonstrated problems from unresolved concerns.    |
| Output               | Findings ordered by impact, followed by a concise assessment and material coverage limitations.                                                    |
| Stop and return when | The requested scope has been assessed, or missing context, access or tooling prevents a meaningful conclusion. Report partial coverage explicitly. |

### Review criteria

| Artifact              | Main focus                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code changes          | Correctness, regressions, security, failure handling and maintainability. Inspect surrounding code as needed; distinguish newly introduced issues from pre-existing ones. |
| Architecture or plans | Whether the approach meets requirements, assumptions hold, dependencies are accounted for and implementation is feasible.                                                 |
| Interfaces            | Usability, accessibility, interaction states, consistency and implementation defects.                                                                                     |
| Documents or analysis | Whether evidence supports claims, reasoning holds, requirements are met and material qualifications are preserved. Apply author guidance when reviewing style.            |

### Review working rules

- **Make each finding actionable.** Identify the location, problem, conditions under which it matters, likely consequence and suggested direction for correction.
- **Separate impact from certainty.** A potentially serious issue with incomplete evidence is an open concern, not a confirmed defect.
- **Avoid manufacturing findings.** "No actionable findings" is valid. Personal preferences are not defects unless they conflict with requirements or established conventions.
- **Keep verification isolated.** Tests and reproductions may create temporary artifacts, but must not alter the reviewed work, shared services or live data.
- **Keep review independent.** Read the actual artifact and supporting evidence. Treat the author's explanation as context, not proof.
- **Return findings to the parent.** No automatic fixes, remote comments, publication or merging.

Prioritize findings as **blocking**, **important** or **minor**, based on consequences for the intended use. Keep unresolved questions separate from confirmed findings.

`review` assesses and recommends. The parent decides what to address and assigns revisions. The task prompt identifies the artifact; an optional `reviewTarget` selects explicit code changes. Omitting it never implies uncommitted changes. Recorded targets survive native and artifact-based recovery.

Deliberate cross-model review is an option for consequential work, not a requirement or a guarantee against shared blind spots. Direct execution needs its own review instructions; it does not inherit a profile contract. A separate session using the same model still provides an independent assessment, but not model diversity.

## Model selection and failures

There are no configured fallback models in this design. If the selected model cannot start or fails during execution, report the failure and any partial work. Do not automatically switch models or launch another writer. The parent decides whether to retry, select another model explicitly or reassign the task.

Reassignment is parent-controlled. The parent may retry the configured profile or delegate a new task explicitly. Direct execution does not automatically inherit profile instructions, and profile/model overrides are not supported. Any selected harness and model must provide the tools required by the task and respect the delegated action boundaries.

Evaluate assignments on representative tasks using correct outcomes, scope discipline, tool reliability, honest validation reports and parent correction effort. Include elapsed time and cost where measurable. Reasoning-effort labels are model-specific and do not establish comparative quality.

- **code:** Use GLM-5.3-Flash · high for now. Validate recognition of scope expansion and consequential design decisions as well as implementation quality.
- **scout / lookup:** Check whether effort levels improve useful findings enough to justify their runtime. A larger effort label does not establish better retrieval.
- **ui:** Validate browser and image inspection reliability, not just model availability.
- **write:** Evaluate actual English and German tasks against the author's preferences.

### Evaluation candidates

These models are outside automatic routing. They are possible deliberate evaluation choices, not fallback assignments.

| Model                                                       | Profiles to evaluate                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Sol · medium**, **Luna · xhigh**, **GLM-5.3-Flash · max** | `code`, as comparisons against the selected GLM-5.3-Flash · high configuration.                           |
| **Qwen3.8-Flash · medium**                                  | `scout`, `lookup`                                                                                         |
| **Kimi K3**, effort mapping to verify                       | `code`, `research`; confirm the exact model, effort configuration and tool reliability before evaluation. |
| **Grok-4.6 · medium**                                       | `research`                                                                                                |
| **DeepSeek V4.1 Flash · max**                               | Future evaluation, especially `code` and `build`. Held out of defaults pending hands-on testing.          |

## Harness direction

- **Pi:** Current primary harness.
- **OpenCode:** Intended primary harness for the redesigned setup.
- **Claude Code:** Harness for Fable assignments.
- **Codex CLI:** Optional harness.

Harness assignments and provider model IDs are configured in source. Pi primary IDs were checked against the local model registry without network refresh. Supported effort mappings and required tools still need representative end-to-end validation. Model availability alone does not establish that a harness can perform a profile's tasks.

The user confirmed Astra at high effort and GLM-5.3-Flash at high effort as verified on 2026-09-18 during the OpenCode capability discussion. Treat that model/effort compatibility check as resolved. It does not establish model quality on representative profile tasks or validate the future adapter.

## Browser integration

**Playwright CLI with Playwright-managed Chromium and the `playwright-cli` skill is the chosen browser workflow**, including for `ui` visual inspection and interaction. Each child performing browser work must load the skill and have command execution, artifact reading and image inspection available through its harness.

Use the host-managed CLI and browser configuration described by the skill: full Playwright-managed Chromium, headless operation, browser sandbox enabled and an isolated profile. Each task uses its own named session and cleans up only that session. Browser control runs through the CLI and requires no browser MCP server.

The skill and host configuration remain the source of operational instructions. Implementation must verify skill loading, CLI access, navigation, interaction and screenshot inspection through the selected harnesses. A successful screenshot command alone does not establish that the child inspected the image. Report observed compatibility or validation limits as part of task results.

## Tool access

Tool isolation is out of scope for this redesign. Keep existing harness tool access and existing restrictions on nested delegation and interactive questions unchanged. Do not add per-profile tool allowlists, new MCP filtering or a permission framework.

Profile action boundaries remain instructions, not a sandbox. Tool availability does not authorize actions beyond the delegated scope.

## Remaining validation and future work

- Validate the selected models on representative tasks, including `code` scope recognition and correction effort.
- Assess whether `lookup` earns a separate profile through useful delegated external investigations.
- Confirm end-to-end harness support for required models, effort levels, tools, skills and author-guidance loading.
- Verify the Playwright CLI workflow, managed Chromium, skill loading and screenshot inspection through the selected harnesses.
- Evaluate and implement the OpenCode adapter separately; it is not required for these eight profiles.
