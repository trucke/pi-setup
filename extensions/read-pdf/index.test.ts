import * as NodeServices from "@effect/platform-node/NodeServices";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  isPublicIpAddress,
  parsePages,
  parseRemotePdfUrl,
  selectPages,
} from "./index.ts";
import { PdfProcessTimeoutError, runPdfCommand } from "./process.ts";

test("applies the page budget predictably and validates explicit ranges", () => {
  assert.deepEqual(selectPages(undefined, 250, 100), {
    pages: Array.from({ length: 100 }, (_, index) => index + 1),
    requestedPageCount: 250,
    budgetTruncated: true,
    explicit: false,
  });
  assert.deepEqual(selectPages(parsePages("3-5,5-7"), 10, 3), {
    pages: [3, 4, 5],
    requestedPageCount: 5,
    budgetTruncated: true,
    explicit: true,
  });
  assert.throws(
    () => selectPages(parsePages("1,11"), 10, 100),
    /PDF has 10 pages/,
  );
});

test("accepts only credential-free HTTP(S) URLs with public literal hosts", () => {
  assert.equal(parseRemotePdfUrl("manual.pdf"), undefined);
  assert.equal(parseRemotePdfUrl("chapter:notes.pdf"), undefined);
  assert.equal(
    parseRemotePdfUrl("https://example.com/manual.pdf")?.protocol,
    "https:",
  );
  assert.throws(
    () => parseRemotePdfUrl("ftp://example.com/a.pdf"),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () => parseRemotePdfUrl("https://user:secret@example.com/a.pdf"),
    /embedded credentials/,
  );
  assert.throws(
    () => parseRemotePdfUrl("http://localhost/a.pdf"),
    /not public/,
  );
  assert.throws(
    () => parseRemotePdfUrl("https://records.internal/a.pdf"),
    /not public/,
  );
  assert.throws(
    () => parseRemotePdfUrl("http://127.0.0.1/a.pdf"),
    /not public/,
  );
  assert.throws(() => parseRemotePdfUrl("http://[::1]/a.pdf"), /not public/);
  assert.equal(isPublicIpAddress("2002:7f00:1::"), false);
  assert.equal(isPublicIpAddress("64:ff9b::a00:1"), false);
  assert.equal(isPublicIpAddress("2002:808:808::"), true);
  assert.equal(isPublicIpAddress("64:ff9b::808:808"), true);
});

test("bounds child processes with a typed timeout", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      runPdfCommand({
        command: process.execPath,
        args: [
          "-e",
          'process.on("SIGTERM", () => {}); setInterval(() => undefined, 1_000)',
        ],
        maxStdoutBytes: 1_024,
        timeoutMs: 25,
        forceKillAfterMs: 25,
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  assert.ok(error instanceof PdfProcessTimeoutError);
  assert.match(error.message, /timed out after 0\.025 seconds/);
});
