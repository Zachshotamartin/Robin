import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BoundedOutputMultiplexer,
  ProcessToolError,
} from "./index.js";

test("preserves observed channel order, byte offsets, and streaming hashes", () => {
  const output = new BoundedOutputMultiplexer({
    retainedHeadBytes: 16,
    retainedTailBytes: 16,
    absoluteBytes: 128,
  });
  const first = output.append("stdout", Buffer.from("one"));
  const second = output.append("stderr", Buffer.from("two"));
  const third = output.append("stdout", Buffer.from("three"));

  assert.deepEqual(
    [first.sequence, second.sequence, third.sequence],
    [1, 2, 3],
  );
  assert.equal(first.channelOffset, 0);
  assert.equal(third.channelOffset, 3);
  const sealed = output.seal();
  assert.equal(sealed.chunkCount, 3);
  assert.equal(sealed.stdout.byteLength, 8);
  assert.equal(sealed.stderr.byteLength, 3);
  assert.equal(
    sealed.stdout.sha256,
    createHash("sha256").update("onethree").digest("hex"),
  );
  assert.equal(sealed.stdout.headText, "onethree");
  assert.equal(sealed.stdout.truncated, false);
});

test("retains bounded head and tail while continuing to hash drained bytes", () => {
  const output = new BoundedOutputMultiplexer({
    retainedHeadBytes: 4,
    retainedTailBytes: 3,
    absoluteBytes: 64,
  });
  output.append("stdout", Buffer.from("abcdefghijkl"));
  const sealed = output.seal();

  assert.equal(sealed.stdout.headBase64, Buffer.from("abcd").toString("base64"));
  assert.equal(sealed.stdout.tailBase64, Buffer.from("jkl").toString("base64"));
  assert.equal(sealed.stdout.omittedBytes, 5);
  assert.equal(sealed.stdout.truncated, true);
  assert.equal(
    sealed.stdout.sha256,
    createHash("sha256").update("abcdefghijkl").digest("hex"),
  );
});

test("classifies partial UTF-8, binary bytes, ANSI, controls, and bidi safely", () => {
  const output = new BoundedOutputMultiplexer({
    retainedHeadBytes: 128,
    retainedTailBytes: 0,
    absoluteBytes: 256,
  });
  const euro = Buffer.from("€");
  const partial = output.append("stdout", euro.subarray(0, 2));
  assert.equal(partial.safeText, "");
  const completed = output.append("stdout", euro.subarray(2));
  assert.equal(completed.safeText, "€");
  output.append("stderr", Buffer.from([0xff, 0x00, 0x1b]));
  output.append("stdout", Buffer.from("\u202eX"));
  const sealed = output.seal();

  assert.equal(sealed.stderr.encoding, "binary_or_invalid_utf8");
  assert.match(sealed.stderr.headText, /\\xff\\x00\\x1b/u);
  assert.match(sealed.stdout.headText, /\\u202eX/u);
  assert.equal(sealed.stdout.controlsEscaped, true);
});

test("reports the absolute drain limit without growing retained memory", () => {
  const output = new BoundedOutputMultiplexer({
    retainedHeadBytes: 2,
    retainedTailBytes: 2,
    absoluteBytes: 5,
  });
  assert.equal(output.append("stdout", Buffer.from("1234")).limitExceeded, false);
  assert.equal(output.append("stderr", Buffer.from("5678")).limitExceeded, true);
  const sealed = output.seal();
  assert.equal(sealed.totalByteLength, 8);
  assert.equal(sealed.limitExceeded, true);
  assert.equal(sealed.retainedByteLength <= 8, true);
  assert.throws(
    () => output.append("stdout", Buffer.from("late")),
    (error: unknown) =>
      error instanceof ProcessToolError && error.code === "invariant_violated",
  );
  assert.throws(() => output.seal(), ProcessToolError);
});
