import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "./src/output.ts";

test("head chunks are evicted past the cap and accounted as truncated", () => {
  const buf = new OutputBuffer(10);
  buf.push("aaaa"); // 4 bytes
  buf.push("bbbb"); // 8 bytes
  buf.push("cccc"); // 12 bytes -> evict "aaaa" (8 retained)
  const view = buf.view();
  assert.equal(view.text, "bbbbcccc");
  assert.equal(view.totalBytes, 12);
  assert.equal(view.truncatedBytes, 4);
});

test("a single chunk larger than the cap is trimmed to its tail — retention stays bounded", () => {
  const buf = new OutputBuffer(4);
  buf.push("0123456789");
  // Only the newest cap-worth of bytes is retained; the head is truncated.
  assert.equal(buf.view().text, "6789");
  assert.equal(buf.view().totalBytes, 10);
  assert.equal(buf.view().truncatedBytes, 6);
  buf.push("x");
  // "6789" + "x" exceeds the cap; the older whole chunk is evicted.
  assert.equal(buf.view().text, "x");
  assert.equal(buf.view().totalBytes, 11);
  assert.equal(buf.view().truncatedBytes, 10);
});

test("an oversized chunk cut lands on a UTF-8 code point boundary", () => {
  const buf = new OutputBuffer(5);
  buf.push("ééééé"); // 10 bytes; naive cut at byte 5 would split an é
  const view = buf.view();
  assert.equal(view.text, "éé"); // 4 bytes retained (5 would split)
  assert.equal(view.totalBytes, 10);
  assert.equal(view.truncatedBytes, 6);
  assert.ok(!view.text.includes("�"));
});

test("spill receives the complete oversized chunk before trimming", () => {
  const spilled: string[] = [];
  const buf = new OutputBuffer(4, (chunk) => spilled.push(chunk));
  buf.push("0123456789");
  assert.deepEqual(spilled, ["0123456789"]);
  assert.equal(buf.view().text, "6789");
});

test("push reports spill backpressure while retaining the chunk", () => {
  const buf = new OutputBuffer(1024, () => false);
  assert.equal(buf.push("queued"), false);
  assert.equal(buf.view().text, "queued");
});
