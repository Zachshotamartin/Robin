const ESCAPE = 0x1b;
const PASTE_END = Uint8Array.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);

export interface KeyDecoderLimits {
  readonly maximumControlBytes: number;
  readonly maximumPasteBytes: number;
  readonly maximumTextBytesPerEvent: number;
}

export const DEFAULT_KEY_DECODER_LIMITS: KeyDecoderLimits = Object.freeze({
  maximumControlBytes: 64,
  maximumPasteBytes: 65_536,
  maximumTextBytesPerEvent: 4_096,
});

export type DecodedKeyEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "enter" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "left" | "right" | "up" | "down" | "home" | "end" }
  | {
      readonly type:
        | "ctrl_a"
        | "ctrl_e"
        | "ctrl_u"
        | "ctrl_k"
        | "ctrl_w"
        | "ctrl_c"
        | "ctrl_d";
    }
  | { readonly type: "resize"; readonly columns: number; readonly rows: number };

export interface KeyDecoderDiagnostic {
  readonly code:
    | "invalid_utf8"
    | "unknown_control"
    | "oversized_control"
    | "oversized_paste"
    | "unterminated_control"
    | "unterminated_paste";
  readonly discardedBytes: number;
}

export interface KeyDecodeBatch {
  readonly events: readonly DecodedKeyEvent[];
  readonly diagnostics: readonly KeyDecoderDiagnostic[];
}

export class TerminalKeyDecoder {
  readonly #limits: KeyDecoderLimits;
  #pendingBytes: number[] = [];
  #controlBytes: number[] | null = null;
  #discardingControl = false;
  #pasteBytes: number[] | null = null;
  #pasteCandidate: number[] = [];
  #pasteDiscarded = 0;
  #lastWasCarriageReturn = false;

  public constructor(limits: Partial<KeyDecoderLimits> = {}) {
    this.#limits = captureLimits(limits);
  }

  public push(bytes: Uint8Array): KeyDecodeBatch {
    const events: DecodedKeyEvent[] = [];
    const diagnostics: KeyDecoderDiagnostic[] = [];
    for (const byte of bytes) {
      if (this.#discardingControl) {
        if (byte >= 0x40 && byte <= 0x7e) this.#discardingControl = false;
      } else if (this.#pasteBytes !== null) {
        this.#consumePasteByte(byte, events, diagnostics);
      } else if (this.#controlBytes !== null) {
        this.#consumeControlByte(byte, events, diagnostics);
      } else if (this.#pendingBytes.length > 0) {
        this.#pendingBytes.push(byte);
        this.#flushPendingUtf8(events, diagnostics, false);
      } else {
        this.#consumeOrdinaryByte(byte, events, diagnostics);
      }
    }
    return freezeBatch(events, diagnostics);
  }

  public resize(columns: number, rows: number): KeyDecodeBatch {
    if (
      !Number.isSafeInteger(columns) ||
      !Number.isSafeInteger(rows) ||
      columns <= 0 ||
      rows <= 0 ||
      columns > 10_000 ||
      rows > 10_000
    ) {
      return freezeBatch([], [
        { code: "unknown_control", discardedBytes: 0 },
      ]);
    }
    return freezeBatch([{ type: "resize", columns, rows }], []);
  }

  public end(): KeyDecodeBatch {
    const events: DecodedKeyEvent[] = [];
    const diagnostics: KeyDecoderDiagnostic[] = [];
    if (this.#pendingBytes.length > 0) {
      this.#flushPendingUtf8(events, diagnostics, true);
    }
    if (this.#controlBytes !== null) {
      diagnostics.push({
        code: "unterminated_control",
        discardedBytes: this.#controlBytes.length,
      });
      this.#controlBytes = null;
    }
    this.#discardingControl = false;
    if (this.#pasteBytes !== null) {
      diagnostics.push({
        code: "unterminated_paste",
        discardedBytes:
          this.#pasteBytes.length + this.#pasteCandidate.length + this.#pasteDiscarded,
      });
      this.#resetPaste();
    }
    this.#lastWasCarriageReturn = false;
    return freezeBatch(events, diagnostics);
  }

  #consumeOrdinaryByte(
    byte: number,
    events: DecodedKeyEvent[],
    diagnostics: KeyDecoderDiagnostic[],
  ): void {
    if (byte === ESCAPE) {
      this.#controlBytes = [byte];
      this.#lastWasCarriageReturn = false;
      return;
    }
    const control = controlEvent(byte);
    if (control !== null) {
      if (byte === 0x0a && this.#lastWasCarriageReturn) {
        this.#lastWasCarriageReturn = false;
        return;
      }
      events.push(control);
      this.#lastWasCarriageReturn = byte === 0x0d;
      return;
    }
    this.#lastWasCarriageReturn = false;
    if (byte < 0x20 || byte === 0x7f) {
      diagnostics.push({ code: "unknown_control", discardedBytes: 1 });
      return;
    }
    if (byte <= 0x7f) {
      appendTextEvent(
        events,
        String.fromCodePoint(byte),
        this.#limits.maximumTextBytesPerEvent,
      );
    } else {
      this.#pendingBytes = [byte];
      this.#flushPendingUtf8(events, diagnostics, false);
    }
  }

  #flushPendingUtf8(
    events: DecodedKeyEvent[],
    diagnostics: KeyDecoderDiagnostic[],
    final: boolean,
  ): void {
    while (this.#pendingBytes.length > 0) {
      const first = this.#pendingBytes[0]!;
      if (first <= 0x7f) {
        this.#pendingBytes.shift();
        this.#consumeOrdinaryByte(first, events, diagnostics);
        continue;
      }
      const decoded = decodeOneUtf8(this.#pendingBytes);
      if (decoded.kind === "incomplete" && !final) return;
      if (decoded.kind === "valid") {
        appendTextEvent(events, decoded.text, this.#limits.maximumTextBytesPerEvent);
        this.#pendingBytes.splice(0, decoded.bytes);
      } else {
        diagnostics.push({ code: "invalid_utf8", discardedBytes: 1 });
        appendTextEvent(events, "\ufffd", this.#limits.maximumTextBytesPerEvent);
        this.#pendingBytes.shift();
      }
    }
  }

  #consumeControlByte(
    byte: number,
    events: DecodedKeyEvent[],
    diagnostics: KeyDecoderDiagnostic[],
  ): void {
    const control = this.#controlBytes!;
    control.push(byte);
    if (control.length > this.#limits.maximumControlBytes) {
      diagnostics.push({ code: "oversized_control", discardedBytes: control.length });
      this.#controlBytes = null;
      this.#discardingControl = true;
      return;
    }
    if (control.length === 2 && control[1] !== 0x5b && control[1] !== 0x4f) {
      diagnostics.push({ code: "unknown_control", discardedBytes: control.length });
      this.#controlBytes = null;
      return;
    }
    const isCsi = control[1] === 0x5b;
    const isSs3 = control[1] === 0x4f;
    if (!isCsi && !isSs3) return;
    const last = control.at(-1)!;
    const complete = isSs3
      ? control.length >= 3
      : control.length >= 3 && last >= 0x40 && last <= 0x7e;
    if (!complete) return;
    const sequence = Buffer.from(control).toString("ascii");
    this.#controlBytes = null;
    if (sequence === "\u001b[200~") {
      this.#pasteBytes = [];
      this.#pasteCandidate = [];
      this.#pasteDiscarded = 0;
      return;
    }
    const event = escapeSequenceEvent(sequence);
    if (event === null) {
      diagnostics.push({ code: "unknown_control", discardedBytes: control.length });
    } else {
      events.push(event);
    }
  }

  #consumePasteByte(
    byte: number,
    events: DecodedKeyEvent[],
    diagnostics: KeyDecoderDiagnostic[],
  ): void {
    this.#pasteCandidate.push(byte);
    while (!isPrefix(this.#pasteCandidate, PASTE_END)) {
      const shifted = this.#pasteCandidate.shift()!;
      if (this.#pasteBytes!.length < this.#limits.maximumPasteBytes) {
        this.#pasteBytes!.push(shifted);
      } else {
        this.#pasteDiscarded += 1;
      }
    }
    if (this.#pasteCandidate.length !== PASTE_END.length) return;

    if (this.#pasteDiscarded > 0) {
      diagnostics.push({
        code: "oversized_paste",
        discardedBytes: this.#pasteBytes!.length + this.#pasteDiscarded,
      });
      this.#resetPaste();
      return;
    }

    const decoded = decodeUtf8Replacing(this.#pasteBytes!);
    if (decoded.invalidBytes > 0) {
      diagnostics.push({ code: "invalid_utf8", discardedBytes: decoded.invalidBytes });
    }
    events.push({ type: "paste", text: decoded.text });
    this.#resetPaste();
  }

  #resetPaste(): void {
    this.#pasteBytes = null;
    this.#pasteCandidate = [];
    this.#pasteDiscarded = 0;
  }
}

function captureLimits(limits: Partial<KeyDecoderLimits>): KeyDecoderLimits {
  return Object.freeze({
    maximumControlBytes: positiveLimit(
      limits.maximumControlBytes,
      DEFAULT_KEY_DECODER_LIMITS.maximumControlBytes,
    ),
    maximumPasteBytes: positiveLimit(
      limits.maximumPasteBytes,
      DEFAULT_KEY_DECODER_LIMITS.maximumPasteBytes,
    ),
    maximumTextBytesPerEvent: positiveLimit(
      limits.maximumTextBytesPerEvent,
      DEFAULT_KEY_DECODER_LIMITS.maximumTextBytesPerEvent,
    ),
  });
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw new TypeError("Key decoder limits must be positive bounded integers.");
  }
  return value;
}

function controlEvent(byte: number): DecodedKeyEvent | null {
  switch (byte) {
    case 0x01:
      return { type: "ctrl_a" };
    case 0x03:
      return { type: "ctrl_c" };
    case 0x04:
      return { type: "ctrl_d" };
    case 0x05:
      return { type: "ctrl_e" };
    case 0x0b:
      return { type: "ctrl_k" };
    case 0x15:
      return { type: "ctrl_u" };
    case 0x17:
      return { type: "ctrl_w" };
    case 0x08:
    case 0x7f:
      return { type: "backspace" };
    case 0x0a:
    case 0x0d:
      return { type: "enter" };
    default:
      return null;
  }
}

function escapeSequenceEvent(sequence: string): DecodedKeyEvent | null {
  switch (sequence) {
    case "\u001b[A":
      return { type: "up" };
    case "\u001b[B":
      return { type: "down" };
    case "\u001b[C":
      return { type: "right" };
    case "\u001b[D":
      return { type: "left" };
    case "\u001b[H":
    case "\u001b[1~":
    case "\u001bOH":
      return { type: "home" };
    case "\u001b[F":
    case "\u001b[4~":
    case "\u001bOF":
      return { type: "end" };
    case "\u001b[3~":
      return { type: "delete" };
    default:
      return null;
  }
}

function appendTextEvent(
  events: DecodedKeyEvent[],
  text: string,
  maximumBytes: number,
): void {
  const last = events.at(-1);
  if (last?.type === "text") {
    const combined = last.text + text;
    if (Buffer.byteLength(combined, "utf8") <= maximumBytes) {
      events[events.length - 1] = { type: "text", text: combined };
      return;
    }
  }
  events.push({ type: "text", text });
}

type Utf8DecodeResult =
  | { readonly kind: "valid"; readonly bytes: number; readonly text: string }
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid" };

function decodeOneUtf8(bytes: readonly number[]): Utf8DecodeResult {
  const first = bytes[0]!;
  if (first <= 0x7f) return { kind: "valid", bytes: 1, text: String.fromCodePoint(first) };
  let count: number;
  let minimum: number;
  let codePoint: number;
  if (first >= 0xc2 && first <= 0xdf) {
    count = 2;
    minimum = 0x80;
    codePoint = first & 0x1f;
  } else if (first >= 0xe0 && first <= 0xef) {
    count = 3;
    minimum = 0x800;
    codePoint = first & 0x0f;
  } else if (first >= 0xf0 && first <= 0xf4) {
    count = 4;
    minimum = 0x10000;
    codePoint = first & 0x07;
  } else {
    return { kind: "invalid" };
  }
  for (let index = 1; index < Math.min(bytes.length, count); index += 1) {
    const byte = bytes[index]!;
    if ((byte & 0xc0) !== 0x80) return { kind: "invalid" };
  }
  if (bytes.length < count) return { kind: "incomplete" };
  for (let index = 1; index < count; index += 1) {
    const byte = bytes[index]!;
    codePoint = (codePoint << 6) | (byte & 0x3f);
  }
  if (
    codePoint < minimum ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", bytes: count, text: String.fromCodePoint(codePoint) };
}

function decodeUtf8Replacing(bytes: readonly number[]): {
  readonly text: string;
  readonly invalidBytes: number;
} {
  let text = "";
  let invalidBytes = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const result = decodeOneUtf8(bytes.slice(offset));
    if (result.kind === "valid") {
      text += result.text;
      offset += result.bytes;
    } else {
      text += "\ufffd";
      invalidBytes += 1;
      offset += 1;
    }
  }
  return { text, invalidBytes };
}

function isPrefix(candidate: readonly number[], expected: Uint8Array): boolean {
  return (
    candidate.length <= expected.length &&
    candidate.every((byte, index) => byte === expected[index])
  );
}

function freezeBatch(
  events: readonly DecodedKeyEvent[],
  diagnostics: readonly KeyDecoderDiagnostic[],
): KeyDecodeBatch {
  return Object.freeze({
    events: Object.freeze(events.map((event) => Object.freeze({ ...event }))),
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
  });
}
