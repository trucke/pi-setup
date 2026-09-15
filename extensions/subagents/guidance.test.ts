import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadChildGuidance } from "./src/guidance.ts";

test("non-Pi guidance discovers context and skills without running extensions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-guidance-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const skill = path.join(cwd, ".pi", "skills", "audit-fixture", "SKILL.md");
  try {
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"));
    fs.writeFileSync(
      path.join(cwd, ".pi", "extensions", "fail.ts"),
      'throw new Error("must not execute");',
    );
    fs.writeFileSync(
      path.join(agentDir, "AGENTS.md"),
      "Read the configured author guide before writing.",
    );
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Project guidance.");
    fs.writeFileSync(
      skill,
      "---\nname: audit-fixture\ndescription: Fixture workflow for this test.\n---\nFollow the fixture.\n",
    );
    const trusted = await loadChildGuidance(cwd, true, agentDir);
    assert.ok(
      trusted.includes(JSON.stringify(path.join(agentDir, "AGENTS.md"))),
    );
    assert.ok(trusted.includes(JSON.stringify(path.join(cwd, "AGENTS.md"))));
    assert.match(trusted, /Fixture workflow for this test/);
    assert.ok(trusted.includes(JSON.stringify(skill)));
    assert.match(trusted, /read the context files/);
    const untrusted = await loadChildGuidance(cwd, false, agentDir);
    assert.ok(!untrusted.includes(JSON.stringify(skill)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
