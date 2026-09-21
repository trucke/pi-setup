import assert from "node:assert/strict";
import test from "node:test";
import { contextOccupancyTokens } from "./src/backends/claude.ts";
import { parseThreadTokenUsage } from "./src/backends/codex.ts";

// --- Claude: per-request occupancy, never the run aggregate ------------------

test("Claude occupancy sums one request's input, cache, and output tokens", () => {
  assert.equal(
    contextOccupancyTokens({
      input_tokens: 12,
      cache_read_input_tokens: 45_000,
      // The SDK reports absent cache counts as null, not zero.
      cache_creation_input_tokens: null,
      output_tokens: 700,
    }),
    45_712,
  );
});

test("Claude occupancy is unknown without a usable per-request usage", () => {
  assert.equal(contextOccupancyTokens(undefined), undefined);
  assert.equal(contextOccupancyTokens(null), undefined);
  assert.equal(
    contextOccupancyTokens({ input_tokens: null, output_tokens: 5 }),
    undefined,
  );
});

// --- Codex: last request's total, never the thread-cumulative total ----------

const codexParams = (tokenUsage: unknown) => ({
  threadId: "t",
  turnId: "u",
  tokenUsage,
});

test("Codex occupancy uses tokenUsage.last.totalTokens, not the cumulative total", () => {
  const { contextTokens, contextWindow } = parseThreadTokenUsage(
    codexParams({
      total: {
        totalTokens: 1_450_000,
        inputTokens: 1_400_000,
        cachedInputTokens: 1_300_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 20_000,
      },
      last: {
        totalTokens: 61_000,
        inputTokens: 60_000,
        cachedInputTokens: 55_000,
        outputTokens: 1_000,
        reasoningOutputTokens: 400,
      },
      modelContextWindow: 272_000,
    }),
  );
  assert.equal(contextTokens, 61_000);
  assert.equal(contextWindow, 272_000);
});

test("Codex occupancy is unknown when last usage or window is absent", () => {
  assert.deepEqual(
    parseThreadTokenUsage(
      codexParams({ total: { totalTokens: 10 }, modelContextWindow: null }),
    ),
    {
      contextTokens: undefined,
      contextWindow: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
  );
  assert.deepEqual(parseThreadTokenUsage({ threadId: "t" }), {
    contextTokens: undefined,
    contextWindow: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
});
