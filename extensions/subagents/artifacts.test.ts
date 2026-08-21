import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import {
  createArtifactPaths,
  persistSnapshot,
  pruneArtifacts,
} from "./src/artifacts.ts";
import type { SubagentSnapshot } from "./src/domain.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-artifacts-"));
process.env.PI_SUBAGENT_STATE_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

function snapshot(
  id: string,
  status: SubagentSnapshot["status"],
  lastActivityAt: number,
): SubagentSnapshot {
  const selected = {
    harness: "codex" as const,
    model: "test",
    runMode: "agent" as const,
  };
  return {
    id,
    origin: "model",
    backend: "codex",
    title: id,
    prompt: "test",
    cwd: root,
    parentCwd: root,
    status,
    startedAt: lastActivityAt - 1,
    lastActivityAt,
    lastEvent: status === "running" ? "RunStarted" : "RunSettled",
    settledAt: status === "running" ? undefined : lastActivityAt,
    meta: { backend: "codex", nativeSessionId: id },
    usage: {},
    execution: {
      requested: { type: "direct" },
      selected,
      attempts: [{ ...selected, outcome: "selected" }],
    },
    transcript: [],
    liveTools: [],
    currentTools: [],
    queued: [],
    finalText: "output",
    turns: 0,
    artifacts: createArtifactPaths(id),
    recovery: { available: false },
  };
}

test("retention never removes unrelated or unvalidated directories", () => {
  const unrelated = path.join(root, "unrelated-data");
  const invalidRun = path.join(root, "sa-deadbeef");
  fs.mkdirSync(unrelated, { recursive: true });
  fs.mkdirSync(invalidRun, { recursive: true });
  fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep");
  fs.writeFileSync(path.join(invalidRun, "snapshot.json"), "{}\n");

  pruneArtifacts(0);

  assert.equal(
    fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8"),
    "keep",
  );
  assert.ok(fs.existsSync(invalidRun));
});

test("retention never removes active run artifacts", () => {
  const active = snapshot("sa-00000001", "running", 1);
  const oldSettled = snapshot("sa-00000002", "done", 2);
  const newSettled = snapshot("sa-00000003", "done", 3);
  persistSnapshot(active);
  persistSnapshot(oldSettled);
  persistSnapshot(newSettled);

  pruneArtifacts(1);

  assert.ok(fs.existsSync(active.artifacts.snapshot));
  assert.ok(fs.existsSync(newSettled.artifacts.snapshot));
  assert.equal(fs.existsSync(oldSettled.artifacts.directory), false);
});
