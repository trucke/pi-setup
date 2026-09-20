import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  BACKEND_NAMES,
  PROFILE_NAMES,
  REASONING_EFFORTS,
  type ExecutionCandidate,
  type ProfileName,
  type ReviewTarget,
} from "./domain.ts";
import {
  SUBAGENT_DIRECT_TOOL_DESCRIPTION,
  SUBAGENT_DIRECT_PROMPT_GUIDELINES,
  SUBAGENT_DIRECT_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS as descriptions,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { buildProfilePrompt, EXECUTION_PROFILES } from "./profiles.ts";
import { resolveReviewTarget } from "./review.ts";

interface SpawnRequest {
  readonly prompt: string;
  readonly name: string;
  readonly workingDir?: string;
  readonly selected: ExecutionCandidate;
  readonly profile?: ProfileName;
  readonly reviewTarget?: ReviewTarget;
}

type SpawnHandler = (
  request: SpawnRequest,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) => ReturnType<ToolDefinition["execute"]>;

const common = {
  prompt: Type.String({ minLength: 1, description: descriptions.prompt }),
  name: Type.String({ minLength: 1, description: descriptions.name }),
};
// Some tool transports require every property to be emitted. Explicit null
// preserves "not requested" without forcing the model to invent a value.
const workingDir = Type.Optional(
  Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    description: descriptions.workingDir,
  }),
);

const profileParameters = Type.Object(
  {
    ...common,
    profile: StringEnum(PROFILE_NAMES, { description: descriptions.profile }),
    workingDir,
    reviewTarget: Type.Optional(
      Type.Union(
        [
          Type.Object(
            {
              type: StringEnum([
                "uncommittedChanges",
                "baseBranch",
                "commit",
                "pullRequest",
              ] as const),
              branch: Type.Optional(Type.String()),
              sha: Type.Optional(Type.String()),
              number: Type.Optional(Type.Integer({ minimum: 1 })),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ],
        { description: descriptions.reviewTarget },
      ),
    ),
  },
  { additionalProperties: false },
);

const directParameters = Type.Object(
  {
    ...common,
    harness: StringEnum(BACKEND_NAMES, { description: descriptions.harness }),
    workingDir,
    model: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description: descriptions.model,
      }),
    ),
    reasoningEffort: Type.Optional(
      Type.Union([StringEnum(REASONING_EFFORTS), Type.Null()], {
        description: descriptions.reasoningEffort,
      }),
    ),
  },
  { additionalProperties: false },
);

// Keep execution modes in separate schemas so the model cannot combine a
// pinned profile with an explicit backend. No silent overrides or fallbacks.
export function registerSpawnTools(pi: ExtensionAPI, spawn: SpawnHandler) {
  pi.registerTool({
    name: "subagent-spawn",
    label: "Spawn Profile Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: profileParameters,
    prepareArguments(args) {
      if (
        args &&
        typeof args === "object" &&
        ("harness" in args || "model" in args || "reasoningEffort" in args)
      ) {
        throw new Error(
          "To choose a harness or model, use subagent-spawn-direct with prompt, name, harness and optional model/reasoningEffort/workingDir. Remove profile and reviewTarget; describe any review scope in prompt. subagent-spawn only accepts a pinned profile.",
        );
      }
      Value.Assert(profileParameters, args);
      return args;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.reviewTarget && params.profile !== "review") {
        throw new Error(
          'reviewTarget is only for code-change reviews with profile "review". For research, documents or interfaces, omit reviewTarget or set it to null and describe the scope in prompt.',
        );
      }
      return spawn(
        {
          ...params,
          workingDir: params.workingDir ?? undefined,
          prompt: buildProfilePrompt(params.profile, params.prompt),
          selected: EXECUTION_PROFILES[params.profile].execution,
          reviewTarget: params.reviewTarget
            ? resolveReviewTarget(params.reviewTarget)
            : undefined,
        },
        signal,
        ctx,
      );
    },
  });

  pi.registerTool({
    name: "subagent-spawn-direct",
    label: "Spawn Direct Subagent",
    description: SUBAGENT_DIRECT_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_DIRECT_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_DIRECT_PROMPT_GUIDELINES,
    parameters: directParameters,
    prepareArguments(args) {
      if (
        args &&
        typeof args === "object" &&
        ("profile" in args || "reviewTarget" in args)
      ) {
        throw new Error(
          "subagent-spawn-direct does not accept profile or reviewTarget. Remove those fields and include the role, constraints and review scope in prompt. To use a pinned profile instead, call subagent-spawn with prompt, name and profile.",
        );
      }
      Value.Assert(directParameters, args);
      return args;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      return spawn(
        {
          prompt: params.prompt,
          name: params.name,
          workingDir: params.workingDir ?? undefined,
          selected: {
            harness: params.harness,
            model: params.model ?? undefined,
            reasoningEffort: params.reasoningEffort ?? undefined,
            runMode: "agent",
          },
        },
        signal,
        ctx,
      );
    },
  });
}
