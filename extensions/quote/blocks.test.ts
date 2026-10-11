import assert from "node:assert/strict";
import test from "node:test";
import {
  blockquote,
  matchingBlocks,
  quotableBlocks,
  quoteInsertion,
  isQuoteTrigger,
} from "./src/blocks.ts";

const reply = `## Plan

The cache should use a 24-hour TTL.
Refresh it on every read.

- Expire entries nightly
- Keep a backup
  - in S3

\`\`\`ts
const ttl = 24 * 60 * 60;

export { ttl };
\`\`\`

| Key | TTL |
|-----|-----|
| a   | 1h  |

> Never cache secrets.

---`;

test("splits a reply into paragraphs, list items and whole code blocks", () => {
  assert.deepEqual(quotableBlocks(reply), [
    "## Plan",
    "The cache should use a 24-hour TTL.\nRefresh it on every read.",
    "- Expire entries nightly",
    "- Keep a backup\n  - in S3",
    "```ts\nconst ttl = 24 * 60 * 60;\n\nexport { ttl };\n```",
    "| Key | TTL |\n|-----|-----|\n| a   | 1h  |",
    "> Never cache secrets.",
  ]);
});

test("quotes every line and keeps Markdown whitespace", () => {
  assert.equal(
    blockquote("hard break  \r\n\n  indented"),
    "> hard break  \n>\n>   indented",
  );
});

test("keeps the indentation of an indented code block", () => {
  assert.deepEqual(
    quotableBlocks("Example:\n\n    const a = 1;\n    const b = 2;\n"),
    ["Example:", "    const a = 1;\n    const b = 2;"],
  );
});

test("filters blocks by every search word", () => {
  const blocks = [{ text: "Cache TTL is 24 hours" }, { text: "Keep a backup" }];
  assert.deepEqual(matchingBlocks(blocks, "ttl cache"), [blocks[0]]);
  assert.deepEqual(matchingBlocks(blocks, "  "), blocks);
});

test("opens the picker only for a lone > at the line end", () => {
  const at = (lines: string[], col = lines.at(-1)?.length ?? 0) =>
    isQuoteTrigger({ lines, cursor: { line: lines.length - 1, col } });

  assert.equal(at([">"]), true);
  assert.equal(at(["Draft", ">"]), true);
  assert.equal(at(["> "]), false);
  assert.equal(at([">cache"]), false);
  assert.equal(at([">"], 0), false);
  assert.equal(at(["!ls", ">"]), false);
  assert.equal(at(["```", ">"]), false);
  assert.equal(at(["```", "code", "```", ">"]), true);
  // A fence followed by text does not close the code block.
  assert.equal(at(["```", "```not-a-closing-fence", ">"]), false);
});

test("separates an inserted quote from the surrounding draft", () => {
  const insertion = (lines: string[]) =>
    quoteInsertion("> q", {
      lines,
      cursor: { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 },
    });

  assert.equal(insertion([""]), "> q\n\n");
  assert.equal(insertion(["Draft", ""]), "\n> q\n\n");
  assert.equal(insertion(["Draft"]), "\n\n> q\n\n");
});
