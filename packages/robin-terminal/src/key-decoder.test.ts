import assert from "node:assert/strict";
import test from "node:test";

import { TerminalKeyDecoder, type DecodedKeyEvent } from "./key-decoder.js";

const encoder = new TextEncoder();

test("decodes printable UTF-8 across every byte boundary", () => {
  const decoder = new TerminalKeyDecoder();
  const events: DecodedKeyEvent[] = [];
  for (const byte of encoder.encode("Aé界👩🏽‍💻")) {
    events.push(...decoder.push(Uint8Array.of(byte)).events);
  }
  assert.equal(
    events.filter((event) => event.type === "text").map((event) => event.text).join(""),
    "Aé界👩🏽‍💻",
  );
  assert.deepEqual(decoder.end(), { events: [], diagnostics: [] });
});

test("decodes editing keys, controls, CRLF, and resize deterministically", () => {
  const decoder = new TerminalKeyDecoder();
  const bytes = Uint8Array.from([
    0x0d, 0x0a, 0x7f, 0x08,
    0x01, 0x05, 0x15, 0x0b, 0x17, 0x03, 0x04,
    ...encoder.encode("\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001b[3~\u001bOH\u001bOF"),
  ]);
  assert.deepEqual(decoder.push(bytes).events.map((event) => event.type), [
    "enter", "backspace", "backspace",
    "ctrl_a", "ctrl_e", "ctrl_u", "ctrl_k", "ctrl_w", "ctrl_c", "ctrl_d",
    "up", "down", "right", "left", "home", "end", "delete", "home", "end",
  ]);
  assert.deepEqual(decoder.resize(40, 12).events, [
    { type: "resize", columns: 40, rows: 12 },
  ]);
  assert.equal(decoder.resize(0, 12).diagnostics[0]?.code, "unknown_control");
});

test("bracketed paste remains one inert text event and never submits", () => {
  const decoder = new TerminalKeyDecoder();
  const paste = "first\n\u001b[31msecond\u001b[0m\n";
  const bytes = encoder.encode(`\u001b[200~${paste}\u001b[201~`);
  const events: DecodedKeyEvent[] = [];
  for (const byte of bytes) events.push(...decoder.push(Uint8Array.of(byte)).events);
  assert.deepEqual(events, [{ type: "paste", text: paste }]);
  assert.equal(events.some((event) => event.type === "enter"), false);
});

test("invalid UTF-8, unknown and oversized controls, and paste bounds fail safely", () => {
  const invalid = new TerminalKeyDecoder();
  const invalidBatch = invalid.push(Uint8Array.from([0xe2, 0x28, 0xa1]));
  assert.equal(
    invalidBatch.events.filter((event) => event.type === "text").map((event) => event.text).join(""),
    "�(�",
  );
  assert.equal(invalidBatch.diagnostics.length, 2);

  const trailing = new TerminalKeyDecoder();
  const trailingBatch = trailing.push(Uint8Array.from([0xe2, 0x28]));
  assert.equal(trailingBatch.events.map((event) => event.type === "text" ? event.text : "").join(""), "�(");
  const unfinishedUtf8 = new TerminalKeyDecoder();
  unfinishedUtf8.push(Uint8Array.from([0xe2, 0x82]));
  assert.equal(
    unfinishedUtf8.end().events.map((event) => event.type === "text" ? event.text : "").join(""),
    "��",
  );

  const unknown = new TerminalKeyDecoder();
  assert.equal(unknown.push(encoder.encode("\u001b[99~")).diagnostics[0]?.code, "unknown_control");

  const oversizedControl = new TerminalKeyDecoder({ maximumControlBytes: 4 });
  const oversizedControlBatch = oversizedControl.push(
    encoder.encode("\u001b[111111111111"),
  );
  assert.equal(oversizedControlBatch.diagnostics[0]?.code, "oversized_control");
  assert.deepEqual(oversizedControlBatch.events, []);
  assert.deepEqual(oversizedControl.push(encoder.encode("xOK")).events, [
    { type: "text", text: "OK" },
  ]);

  const oversizedPaste = new TerminalKeyDecoder({ maximumPasteBytes: 4 });
  const pasteBatch = oversizedPaste.push(encoder.encode("\u001b[200~abcdef\u001b[201~"));
  assert.deepEqual(pasteBatch.events, []);
  assert.deepEqual(pasteBatch.diagnostics, [
    { code: "oversized_paste", discardedBytes: 6 },
  ]);
  assert.deepEqual(oversizedPaste.push(encoder.encode("OK")).events, [
    { type: "text", text: "OK" },
  ]);

  const unfinished = new TerminalKeyDecoder();
  unfinished.push(encoder.encode("\u001b[200~secret"));
  assert.equal(unfinished.end().diagnostics[0]?.code, "unterminated_paste");
});

test("paste bounds are exact UTF-8 bytes and repeated rejection resets the decoder", () => {
  const decoder = new TerminalKeyDecoder({ maximumPasteBytes: 4 });

  assert.deepEqual(
    decoder.push(encoder.encode("\u001b[200~éé\u001b[201~")),
    {
      events: [{ type: "paste", text: "éé" }],
      diagnostics: [],
    },
  );
  assert.deepEqual(
    decoder.push(encoder.encode("\u001b[200~ééa\u001b[201~")),
    {
      events: [],
      diagnostics: [{ code: "oversized_paste", discardedBytes: 5 }],
    },
  );
  assert.deepEqual(
    decoder.push(encoder.encode("\u001b[200~12345\u001b[201~")),
    {
      events: [],
      diagnostics: [{ code: "oversized_paste", discardedBytes: 5 }],
    },
  );
  assert.deepEqual(
    decoder.push(encoder.encode("\u001b[200~界a\u001b[201~")),
    {
      events: [{ type: "paste", text: "界a" }],
      diagnostics: [],
    },
  );
});
