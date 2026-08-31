import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { readPhysicalFile } from "./physical-read-file.js";
import {
  createRepositoryFixture,
  isDomainCode,
} from "./repository-fixture.test-support.js";

const BASE_REQUEST = Object.freeze({
  maximumFileBytes: 1024 * 1024,
  maximumOutputBytes: 64 * 1024,
  maximumLineSpan: 128,
  preserveAtime: true,
  allowGenerated: false,
});

test("read_file returns exact line and byte windows with stable metadata", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "src/lf.txt": "one\ntwo\nthree\n",
    "src/crlf.txt": "one\r\ntwo\r\nthree",
  });
  const lines = await readPhysicalFile(
    fixture.workspace,
    {
      ...BASE_REQUEST,
      path: "src/lf.txt",
      selector: { kind: "lines", startLine: 2, endLine: 2 },
    },
    new AbortController().signal,
  );
  assert.equal(lines.status, "released");
  if (lines.status === "released") {
    assert.equal(lines.content, "two\n");
    assert.equal(lines.newlineStyle, "lf");
    assert.equal(lines.startLine, 2);
    assert.equal(lines.endLine, 2);
    assert.match(lines.sourceSha256, /^[a-f0-9]{64}$/u);
  }

  const bytes = await readPhysicalFile(
    fixture.workspace,
    {
      ...BASE_REQUEST,
      path: "src/crlf.txt",
      selector: { kind: "bytes", offset: 5, length: 3 },
    },
    new AbortController().signal,
  );
  assert.equal(bytes.status, "released");
  if (bytes.status === "released") {
    assert.equal(bytes.content, "two");
    assert.equal(bytes.newlineStyle, "crlf");
    assert.equal(bytes.leadingPartialLine, false);
    assert.equal(bytes.trailingPartialLine, true);
  }
});

test("UTF-8 BOM is reported while UTF-16, invalid UTF-8, and binary are withheld", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n")]),
    "utf16.txt": Buffer.from([0xff, 0xfe, 0x68, 0x00]),
    "invalid.txt": Buffer.from([0xc3, 0x28]),
    "binary.bin": Buffer.from([0x61, 0x00, 0x62]),
  });
  const bom = await readPhysicalFile(
    fixture.workspace,
    { ...BASE_REQUEST, path: "bom.txt", selector: { kind: "whole" } },
    new AbortController().signal,
  );
  assert.equal(bom.status, "released");
  if (bom.status === "released") {
    assert.equal(bom.encoding, "utf8_bom");
    assert.equal(bom.content, "hello\n");
  }
  for (const [file, reason] of [
    ["utf16.txt", "invalid_encoding"],
    ["invalid.txt", "invalid_encoding"],
    ["binary.bin", "binary"],
  ] as const) {
    const result = await readPhysicalFile(
      fixture.workspace,
      { ...BASE_REQUEST, path: file, selector: { kind: "whole" } },
      new AbortController().signal,
    );
    assert.equal(result.status, "withheld");
    if (result.status === "withheld") assert.equal(result.reason, reason);
  }
});

test("path and content secret classifications withhold bytes without echoing canaries", async (t) => {
  const secret = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKE";
  const fixture = await createRepositoryFixture(t, {
    ".env": `API_KEY=${secret}\n`,
    "src/config.txt": `token=${secret}\n`,
  });
  for (const file of [".env", "src/config.txt"]) {
    const result = await readPhysicalFile(
      fixture.workspace,
      { ...BASE_REQUEST, path: file, selector: { kind: "whole" } },
      new AbortController().signal,
    );
    assert.equal(result.status, "withheld");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("sourceSha256"), false);
  }
});

test("read bounds, scalar boundaries, cancellation, and path swaps fail closed", async (t) => {
  const fixture = await createRepositoryFixture(t, {
    "large.txt": "abcdef😀ghijkl",
    "race.txt": "before",
  });
  const bounded = await readPhysicalFile(
    fixture.workspace,
    {
      ...BASE_REQUEST,
      path: "large.txt",
      selector: { kind: "whole" },
      maximumOutputBytes: 8,
    },
    new AbortController().signal,
  );
  assert.equal(bounded.status, "released");
  if (bounded.status === "released") {
    assert.equal(Buffer.byteLength(bounded.content, "utf8") <= 8, true);
    assert.equal(bounded.truncated, true);
  }
  await assert.rejects(
    readPhysicalFile(
      fixture.workspace,
      {
        ...BASE_REQUEST,
        path: "large.txt",
        selector: { kind: "bytes", offset: 7, length: 1 },
      },
      new AbortController().signal,
    ),
    (error: unknown) => isDomainCode(error, "invalid_input"),
  );

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    readPhysicalFile(
      fixture.workspace,
      { ...BASE_REQUEST, path: "large.txt", selector: { kind: "whole" } },
      cancelled.signal,
    ),
    (error: unknown) => isDomainCode(error, "cancelled"),
  );

  let swapped = false;
  await assert.rejects(
    readPhysicalFile(
      fixture.workspace,
      { ...BASE_REQUEST, path: "race.txt", selector: { kind: "whole" } },
      new AbortController().signal,
      {
        hooks: {
          async afterOpen() {
            if (swapped) return;
            swapped = true;
            await rename(path.join(fixture.root, "race.txt"), path.join(fixture.root, "old.txt"));
            await writeFile(path.join(fixture.root, "race.txt"), "outside-swap", "utf8");
          },
        },
      },
    ),
    (error: unknown) => isDomainCode(error, "conflict"),
  );
});
