import { corrupt } from "./errors.ts";

/** Writes bits least-significant-bit first into a growable byte buffer. */
export class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
  }

  /** Bits written so far, including ones not yet flushed to a whole byte. */
  get bitLength(): number {
    return this.pos * 8 + this.bitCount;
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low `count` bits of `value`. `count` must be at most 24. */
  writeBits(value: number, count: number): void {
    this.ensure(4);
    this.bitBuf |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  /** Pads with zero bits up to the next byte boundary. */
  alignToByte(): void {
    if (this.bitCount > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  /** Writes raw bytes. The writer must be byte-aligned. */
  writeBytes(bytes: Uint8Array): void {
    if (this.bitCount !== 0) throw new Error("BitWriter.writeBytes requires byte alignment");
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  writeUint32LE(value: number): void {
    this.writeBits(value & 0xffff, 16);
    this.writeBits(value >>> 16, 16);
  }

  /** Flushes any partial byte and returns the written bytes. */
  finish(): Uint8Array {
    this.alignToByte();
    return this.buf.subarray(0, this.pos);
  }
}

/** Reads bits least-significant-bit first. Reading past the end throws a CORRUPT error. */
export class BitReader {
  private readonly data: Uint8Array;
  private readonly end: number;
  private pos: number;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(data: Uint8Array, start = 0, end = data.length) {
    this.data = data;
    this.pos = start;
    this.end = end;
  }

  private refill(): void {
    while (this.bitCount <= 24 && this.pos < this.end) {
      this.bitBuf |= this.data[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
  }

  /** Returns the next `count` (at most 24) bits without consuming them; missing bits past the end read as 0. */
  peek(count: number): number {
    if (this.bitCount < count) this.refill();
    return this.bitBuf & ((1 << count) - 1);
  }

  consume(count: number): void {
    if (count > this.bitCount) throw corrupt("Unexpected end of compressed data");
    this.bitBuf >>>= count;
    this.bitCount -= count;
  }

  /** Reads `count` bits, at most 24. */
  readBits(count: number): number {
    if (count === 0) return 0;
    const value = this.peek(count);
    this.consume(count);
    return value;
  }

  /** Skips to the next byte boundary and returns the byte offset of the next unread byte. */
  alignToByte(): number {
    const drop = this.bitCount & 7;
    this.bitBuf >>>= drop;
    this.bitCount -= drop;
    this.pos -= this.bitCount >>> 3;
    this.bitBuf = 0;
    this.bitCount = 0;
    return this.pos;
  }

  /** Moves the read position to `bytePos`. Only valid right after alignToByte(). */
  seekToByte(bytePos: number): void {
    if (bytePos > this.end) throw corrupt("Unexpected end of compressed data");
    this.pos = bytePos;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  get byteEnd(): number {
    return this.end;
  }
}
