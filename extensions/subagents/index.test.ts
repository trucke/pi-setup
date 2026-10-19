import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewTarget } from "./src/review.ts";

test("review targets reject values that could become shell options or commands", () => {
  assert.deepEqual(
    resolveReviewTarget({ type: "baseBranch", branch: "release/v1.2" }),
    { type: "baseBranch", branch: "release/v1.2" },
  );
  assert.deepEqual(resolveReviewTarget({ type: "commit", sha: "abc1234" }), {
    type: "commit",
    sha: "abc1234",
  });
  assert.throws(
    () => resolveReviewTarget({ type: "baseBranch", branch: "--output=x" }),
    /safe Git branch/,
  );
  assert.throws(
    () => resolveReviewTarget({ type: "baseBranch", branch: "main; touch x" }),
    /safe Git branch/,
  );
  assert.throws(
    () => resolveReviewTarget({ type: "commit", sha: "HEAD~1" }),
    /commit hash/,
  );
});
