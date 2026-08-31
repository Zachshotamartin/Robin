import { Buffer, isUtf8 } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { ProcessOutputLimits } from "./process-schema.js";
import { ProcessToolError } from "./process-error.js";

export type ProcessOutputChannel = "stdout" | "stderr";

export interface ProcessOutputChunkEvent {
  readonly sequence: number;
  readonly channel: ProcessOutputChannel;
  readonly channelOffset: number;
  readonly byteLength: number;
  readonly safeText: string;
  readonly rawBase64: string;
  readonly limitExceeded: boolean;
}

export interface ProcessOutputChannelSnapshot {
  readonly byteLength: number;
  readonly sha256: string;
  readonly headBase64: string;
  readonly tailBase64: string;
  readonly headText: string;
  readonly tailText: string;
  readonly omittedBytes: number;
  readonly truncated: boolean;
  readonly encoding: "utf8" | "binary_or_invalid_utf8";
  readonly controlsEscaped: boolean;
}

export interface ProcessOutputSnapshot {
  readonly chunkCount: number;
  readonly totalByteLength: number;
  readonly retainedByteLength: number;
  readonly aggregateSha256: string;
  readonly limitExceeded: boolean;
  readonly stdout: ProcessOutputChannelSnapshot;
  readonly stderr: ProcessOutputChannelSnapshot;
}

interface ChannelState {
  readonly hash: Hash;
  readonly decoder: StringDecoder;
  readonly validator: TextDecoder;
  readonly headParts: Buffer[];
  headLength: number;
  tail: Buffer;
  byteLength: number;
  invalidUtf8: boolean;
  controlsEscaped: boolean;
}

export class BoundedOutputMultiplexer {
  readonly #limits: ProcessOutputLimits;
  readonly #aggregateHash = createHash("sha256");
  readonly #channels: Record<ProcessOutputChannel, ChannelState>;
  #sequence = 0;
  #totalByteLength = 0;
  #limitExceeded = false;
  #sealed = false;

  public constructor(limits: ProcessOutputLimits) {
    validateLimits(limits);
    this.#limits = Object.freeze({ ...limits });
    this.#channels = {
      stdout: channelState(),
      stderr: channelState(),
    };
  }

  public append(
    channel: ProcessOutputChannel,
    bytes: Uint8Array,
  ): ProcessOutputChunkEvent {
    if (this.#sealed) invariant("Process output is already sealed.");
    if (channel !== "stdout" && channel !== "stderr") {
      invariant("The process output channel is invalid.");
    }
    const chunk = Buffer.from(bytes);
    const state = this.#channels[channel];
    const channelOffset = state.byteLength;
    state.byteLength += chunk.byteLength;
    this.#totalByteLength += chunk.byteLength;
    this.#sequence += 1;
    state.hash.update(chunk);
    const envelope = Buffer.allocUnsafe(9);
    envelope[0] = channel === "stdout" ? 1 : 2;
    envelope.writeBigUInt64BE(BigInt(chunk.byteLength), 1);
    this.#aggregateHash.update(envelope).update(chunk);
    retain(state, chunk, this.#limits);

    let safeText = state.decoder.write(chunk);
    try {
      state.validator.decode(chunk, { stream: true });
    } catch {
      state.invalidUtf8 = true;
    }
    const escaped = escapeText(safeText);
    safeText = escaped.text;
    state.controlsEscaped ||= escaped.changed;
    if (this.#totalByteLength > this.#limits.absoluteBytes) {
      this.#limitExceeded = true;
    }
    return Object.freeze({
      sequence: this.#sequence,
      channel,
      channelOffset,
      byteLength: chunk.byteLength,
      safeText,
      rawBase64: chunk.toString("base64"),
      limitExceeded: this.#limitExceeded,
    });
  }

  public seal(): ProcessOutputSnapshot {
    if (this.#sealed) invariant("Process output may be sealed only once.");
    this.#sealed = true;
    for (const state of Object.values(this.#channels)) {
      const finalText = state.decoder.end();
      if (finalText.length > 0) {
        const escaped = escapeText(finalText);
        state.controlsEscaped ||= escaped.changed;
      }
      try {
        state.validator.decode();
      } catch {
        state.invalidUtf8 = true;
      }
    }
    const stdout = sealChannel(this.#channels.stdout);
    const stderr = sealChannel(this.#channels.stderr);
    return Object.freeze({
      chunkCount: this.#sequence,
      totalByteLength: this.#totalByteLength,
      retainedByteLength:
        retainedBytes(this.#channels.stdout) + retainedBytes(this.#channels.stderr),
      aggregateSha256: this.#aggregateHash.digest("hex"),
      limitExceeded: this.#limitExceeded,
      stdout,
      stderr,
    });
  }
}

function channelState(): ChannelState {
  return {
    hash: createHash("sha256"),
    decoder: new StringDecoder("utf8"),
    validator: new TextDecoder("utf-8", { fatal: true }),
    headParts: [],
    headLength: 0,
    tail: Buffer.alloc(0),
    byteLength: 0,
    invalidUtf8: false,
    controlsEscaped: false,
  };
}

function retain(
  state: ChannelState,
  chunk: Buffer,
  limits: ProcessOutputLimits,
): void {
  let offset = 0;
  const headRemaining = limits.retainedHeadBytes - state.headLength;
  if (headRemaining > 0) {
    const count = Math.min(headRemaining, chunk.byteLength);
    if (count > 0) {
      state.headParts.push(Buffer.from(chunk.subarray(0, count)));
      state.headLength += count;
      offset = count;
    }
  }
  if (offset >= chunk.byteLength || limits.retainedTailBytes === 0) return;
  const incoming = chunk.subarray(offset);
  if (incoming.byteLength >= limits.retainedTailBytes) {
    state.tail = Buffer.from(incoming.subarray(incoming.byteLength - limits.retainedTailBytes));
    return;
  }
  const combined = Buffer.concat([state.tail, incoming]);
  state.tail =
    combined.byteLength <= limits.retainedTailBytes
      ? combined
      : Buffer.from(combined.subarray(combined.byteLength - limits.retainedTailBytes));
}

function sealChannel(state: ChannelState): ProcessOutputChannelSnapshot {
  const head = Buffer.concat(state.headParts, state.headLength);
  const tail = state.tail;
  const retained = head.byteLength + tail.byteLength;
  const omittedBytes = Math.max(0, state.byteLength - retained);
  const validUtf8 = !state.invalidUtf8 && isUtf8(head) && isUtf8(tail);
  const headPreview = bytePreview(head, validUtf8);
  const tailPreview = bytePreview(tail, validUtf8);
  return Object.freeze({
    byteLength: state.byteLength,
    sha256: state.hash.digest("hex"),
    headBase64: head.toString("base64"),
    tailBase64: tail.toString("base64"),
    headText: headPreview.text,
    tailText: tailPreview.text,
    omittedBytes,
    truncated: omittedBytes > 0,
    encoding: validUtf8 ? "utf8" : "binary_or_invalid_utf8",
    controlsEscaped:
      state.controlsEscaped || headPreview.changed || tailPreview.changed,
  });
}

function bytePreview(
  bytes: Buffer,
  validUtf8: boolean,
): { readonly text: string; readonly changed: boolean } {
  if (validUtf8) return escapeText(bytes.toString("utf8"));
  let text = "";
  let changed = false;
  for (const byte of bytes) {
    if (byte === 0x0a) text += "\n";
    else if (byte === 0x09) text += "\t";
    else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
    else {
      text += `\\x${byte.toString(16).padStart(2, "0")}`;
      changed = true;
    }
  }
  return { text, changed };
}

function escapeText(value: string): { readonly text: string; readonly changed: boolean } {
  let output = "";
  let changed = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (character === "\n" || character === "\t") {
      output += character;
    } else if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      output +=
        codePoint <= 0xff
          ? `\\x${codePoint.toString(16).padStart(2, "0")}`
          : `\\u${codePoint.toString(16).padStart(4, "0")}`;
      changed = true;
    } else if (
      codePoint === 0x202a ||
      codePoint === 0x202b ||
      codePoint === 0x202c ||
      codePoint === 0x202d ||
      codePoint === 0x202e ||
      codePoint === 0x2066 ||
      codePoint === 0x2067 ||
      codePoint === 0x2068 ||
      codePoint === 0x2069
    ) {
      output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      changed = true;
    } else {
      output += character;
    }
  }
  return { text: output, changed };
}

function retainedBytes(state: ChannelState): number {
  return state.headLength + state.tail.byteLength;
}

function validateLimits(limits: ProcessOutputLimits): void {
  for (const value of [
    limits.retainedHeadBytes,
    limits.retainedTailBytes,
    limits.absoluteBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      invariant("Process output limits are invalid.");
    }
  }
  if (
    limits.absoluteBytes <= 0 ||
    limits.absoluteBytes < limits.retainedHeadBytes + limits.retainedTailBytes
  ) {
    invariant("Process output limits are inconsistent.");
  }
}

function invariant(message: string): never {
  throw new ProcessToolError("invariant_violated", message);
}
