import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/** Give non-Pi children the same guidance locations without loading Pi tools. */
export function renderChildGuidance(
  loader: Pick<ResourceLoader, "getAgentsFiles" | "getSkills">,
) {
  const files = loader.getAgentsFiles().agentsFiles;
  const skills = loader
    .getSkills()
    .skills.filter((skill) => !skill.disableModelInvocation);
  if (files.length === 0 && skills.length === 0) return "";
  return [
    "Task guidance",
    "Before working, read the context files below and follow applicable guidance they reference, including author guidance for prose. Read matching skills before using their workflows; resolve their relative references against the skill directory. These are locations, not inherited parent conversation.",
    ...files.map((file) => `Context file: ${JSON.stringify(file.path)}`),
    ...skills.map(
      (skill) =>
        `Skill ${JSON.stringify(skill.name)}: ${skill.description}\nLocation: ${JSON.stringify(skill.filePath)}`,
    ),
  ].join("\n");
}

export async function loadChildGuidance(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
) {
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  return renderChildGuidance(loader);
}
