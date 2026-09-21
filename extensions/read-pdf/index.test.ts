import * as NodeServices from "@effect/platform-node/NodeServices";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  createBoundedPreview,
  formatExtractedPages,
  isPublicIpAddress,
  parsePages,
  parsePdfInfo,
  parseRemotePdfUrl,
  selectPages,
  truncateByCharacters,
} from "./index.ts";
import { PdfProcessTimeoutError, runPdfCommand } from "./process.ts";

test("parses individual PDF pages and ranges", () => {
  assert.deepEqual(parsePages("1, 3-5"), [
    { from: 1, to: 1 },
    { from: 3, to: 5 },
  ]);
  assert.equal(parsePages(), undefined);
});

test("rejects invalid PDF page ranges", () => {
  assert.throws(() => parsePages("5-3"), /Invalid page range/);
  assert.throws(() => parsePages("first"), /Invalid pages value/);
});

test("formats Poppler form-feed pages with their requested page numbers", () => {
  assert.deepEqual(formatExtractedPages("alpha\f\fcharlie\f", [7, 8, 9]), [
    { page: 7, hasText: true, text: "## Page 7\n\nalpha" },
    {
      page: 8,
      hasText: false,
      text: "## Page 8\n\n[No extractable text found on this page.]",
    },
    { page: 9, hasText: true, text: "## Page 9\n\ncharlie" },
  ]);
});

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

test("parses the pdfinfo fields that drive page selection and encryption handling", () => {
  const metadata = parsePdfInfo(
    [
      "Title:          Field Manual",
      "CreationDate:   Tue Jan  2 03:04:05 2024 UTC",
      "Encrypted:      yes (print:no copy:yes)",
      "Pages:          42",
    ].join("\n"),
  );
  assert.equal(metadata.title, "Field Manual");
  // Values may contain colons; only the first one separates key and value.
  assert.equal(metadata.creationDate, "Tue Jan  2 03:04:05 2024 UTC");
  assert.equal(metadata.encrypted, true);
  assert.equal(metadata.pageCount, 42);
});

test("maxChars counts characters rather than UTF-8 bytes", () => {
  assert.deepEqual(truncateByCharacters("A😀éZ", 3), {
    content: "A😀é",
    totalChars: 4,
    outputChars: 3,
    truncated: true,
  });

  const preview = createBoundedPreview("😀".repeat(20_000), 20_000);
  assert.equal(preview.characterTruncated, false);
  assert.equal(preview.standardTruncated, true);
  assert.equal(preview.truncated, true);
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

test("runs Poppler-style child processes through the Effect runtime", async () => {
  const output = await Effect.runPromise(
    runPdfCommand({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("pdf output")'],
      maxStdoutBytes: 1_024,
      timeoutMs: 5_000,
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  assert.equal(output, "pdf output");
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

test("cancelling child processes also removes their timeout", async () => {
  const controller = new AbortController();
  const timeoutCount = () =>
    process.getActiveResourcesInfo().filter((type) => type === "Timeout")
      .length;
  const before = timeoutCount();
  const running = Effect.runPromise(
    runPdfCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      maxStdoutBytes: 1_024,
      timeoutMs: 120_000,
    }).pipe(Effect.provide(NodeServices.layer)),
    { signal: controller.signal },
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await assert.rejects(running);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(timeoutCount(), before);
});
