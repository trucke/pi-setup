import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundedPreview,
  formatExtractedPages,
  isPublicIpAddress,
  parsePages,
  parsePdfInfo,
  parseRemotePdfUrl,
  READ_PDF_TOOL_NAME,
  selectPages,
  truncateByCharacters,
  validateResolvedAddresses,
} from "./index.ts";

test("uses the kebab-case first-party tool name without a legacy alias", () => {
  assert.equal(READ_PDF_TOOL_NAME, "read-pdf");
});

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

test("parses useful pdfinfo fields while retaining raw metadata", () => {
  const raw = [
    "Title:          Field Manual",
    "Author:         A. Example",
    "Subject:        Testing",
    "CreationDate:   Tue Jan  2 03:04:05 2024 UTC",
    "Encrypted:      yes (print:no copy:yes)",
    "Pages:          42",
    "PDF version:    1.7",
  ].join("\n");

  const metadata = parsePdfInfo(raw);
  assert.equal(metadata.title, "Field Manual");
  assert.equal(metadata.author, "A. Example");
  assert.equal(metadata.subject, "Testing");
  assert.equal(metadata.creationDate, "Tue Jan  2 03:04:05 2024 UTC");
  assert.equal(metadata.encrypted, true);
  assert.equal(metadata.encryptionDetails, "(print:no copy:yes)");
  assert.equal(metadata.pageCount, 42);
  assert.equal(metadata.fields["PDF version"], "1.7");
  assert.equal(metadata.raw, raw);
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
});

test("rejects private and special DNS answers", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
  assert.doesNotThrow(() => validateResolvedAddresses(["93.184.216.34"]));
  assert.throws(
    () => validateResolvedAddresses(["93.184.216.34", "10.0.0.1"]),
    /non-public address/,
  );
});
