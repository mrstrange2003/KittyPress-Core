import { BitReader, BitWriter } from "./bitio.ts";
import { corrupt } from "./errors.ts";
import {
  BLOCK_HUFFMAN,
  BLOCK_STORED,
  CL_ORDER,
  END_OF_BLOCK,
  MAX_CL_BITS,
  MAX_CODE_BITS,
  MIN_MATCH,
  NUM_CL_CODES,
  NUM_DIST_CODES,
  NUM_LITLEN_CODES,
  bucketBase,
  bucketCode,
  bucketExtraBits,
  lengthBase,
  lengthCode,
  lengthExtraBits,
} from "./format.ts";
import { HuffmanDecoder, buildCodeLengths, buildCodes } from "./huffman.ts";
import { type Level, type TokenBlock, tokenize } from "./lz77.ts";

export const METHOD_STORED = 0;
export const METHOD_KITTY_LZ = 1;
export type Method = typeof METHOD_STORED | typeof METHOD_KITTY_LZ;

export interface CompressOptions {
  level?: Level;
  /** Called after each block with the number of input bytes processed so far. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

export interface CompressedStream {
  method: Method;
  data: Uint8Array;
}

/**
 * Compresses `data`. Returns the method used: data that doesn't shrink (photos, videos,
 * ZIPs...) is returned as-is with METHOD_STORED. The "max" level skips the quick
 * incompressibility check, so it can still find long-range repeats in such data.
 */
export function compress(data: Uint8Array, options: CompressOptions = {}): CompressedStream {
  const level = options.level ?? "balanced";
  const total = data.length;
  if (total === 0 || (level !== "max" && looksIncompressible(data))) {
    options.onProgress?.(total, total);
    return { method: METHOD_STORED, data };
  }

  const out = new BitWriter(Math.min(total, 1 << 24) + 1024);
  tokenize(data, level, (block, isLast) => {
    writeBlock(out, block, data, isLast);
    options.onProgress?.(block.end, total);
  });
  const encoded = out.finish();
  if (encoded.length >= total) return { method: METHOD_STORED, data };
  return { method: METHOD_KITTY_LZ, data: encoded };
}

/** Restores the original bytes. `originalSize` must be the exact uncompressed size. */
export function decompress(method: number, data: Uint8Array, originalSize: number): Uint8Array {
  if (method === METHOD_STORED) {
    if (data.length !== originalSize) throw corrupt("Stored data has the wrong size");
    return data;
  }
  if (method !== METHOD_KITTY_LZ) throw corrupt(`Unknown compression method ${method}`);
  return decodeStream(data, originalSize);
}

const SAMPLE_SIZE = 64 * 1024;
const SAMPLE_COUNT = 4;

/**
 * Quick check for already-compressed data: compress a few samples with the fast level and
 * see whether they shrink at all. Saves a full compression pass on JPEGs, MP4s, ZIPs, etc.
 */
function looksIncompressible(data: Uint8Array): boolean {
  if (data.length < SAMPLE_SIZE * SAMPLE_COUNT * 2) return false;
  let sampleBytes = 0;
  let packedBits = 0;
  const step = Math.floor((data.length - SAMPLE_SIZE) / (SAMPLE_COUNT - 1));
  for (let s = 0; s < SAMPLE_COUNT; s++) {
    const sample = data.subarray(s * step, s * step + SAMPLE_SIZE);
    const w = new BitWriter(SAMPLE_SIZE + 1024);
    tokenize(sample, "fast", (block, isLast) => writeBlock(w, block, sample, isLast));
    sampleBytes += sample.length;
    packedBits += w.bitLength;
  }
  return packedBits / 8 > sampleBytes * 0.98;
}

// ---------------------------------------------------------------------------------------
// Encoding

const LENGTH_CODE = (() => {
  const table = new Uint8Array(1024);
  for (let x = 0; x < table.length; x++) table[x] = lengthCode(x);
  return table;
})();

/** Run-length encodes a list of code lengths using symbols 16 (repeat), 17 and 18 (zeros). */
function rleCodeLengths(lens: Uint8Array): { syms: number[]; extras: number[] } {
  const syms: number[] = [];
  const extras: number[] = [];
  const push = (sym: number, extra = 0) => {
    syms.push(sym);
    extras.push(extra);
  };
  let i = 0;
  while (i < lens.length) {
    const v = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    let r = run;
    if (v === 0) {
      while (r >= 11) {
        const take = Math.min(r, 138);
        push(18, take - 11);
        r -= take;
      }
      if (r >= 3) {
        push(17, r - 3);
        r = 0;
      }
    } else {
      push(v);
      r--;
      while (r >= 3) {
        const take = Math.min(r, 6);
        push(16, take - 3);
        r -= take;
      }
    }
    for (; r > 0; r--) push(v);
    i += run;
  }
  return { syms, extras };
}

const CL_EXTRA_BITS = [2, 3, 7];

function writeHuffmanHeader(w: BitWriter, litLens: Uint8Array, distLens: Uint8Array): void {
  let hlit = NUM_LITLEN_CODES;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = NUM_DIST_CODES;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;

  const combined = new Uint8Array(hlit + hdist);
  combined.set(litLens.subarray(0, hlit));
  combined.set(distLens.subarray(0, hdist), hlit);
  const { syms, extras } = rleCodeLengths(combined);

  const clFreq = new Uint32Array(NUM_CL_CODES);
  for (const s of syms) clFreq[s]++;
  const clLens = buildCodeLengths(clFreq, MAX_CL_BITS);
  const clCodes = buildCodes(clLens);
  let hclen = NUM_CL_CODES;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;

  w.writeBits(hlit - 257, 6);
  w.writeBits(hdist - 1, 6);
  w.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.writeBits(clLens[CL_ORDER[k]], 3);
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    w.writeBits(clCodes[s], clLens[s]);
    if (s >= 16) w.writeBits(extras[k], CL_EXTRA_BITS[s - 16]);
  }
}

function writeBlock(w: BitWriter, block: TokenBlock, data: Uint8Array, isFinal: boolean): void {
  const { litLen, dist, count } = block;
  const litFreq = new Uint32Array(NUM_LITLEN_CODES);
  const distFreq = new Uint32Array(NUM_DIST_CODES);
  for (let t = 0; t < count; t++) {
    const d = dist[t];
    if (d === 0) {
      litFreq[litLen[t]]++;
    } else {
      litFreq[257 + LENGTH_CODE[litLen[t] - MIN_MATCH]]++;
      distFreq[bucketCode(d - 1)]++;
    }
  }
  litFreq[END_OF_BLOCK] = 1;

  const litLens = buildCodeLengths(litFreq, MAX_CODE_BITS);
  const distLens = buildCodeLengths(distFreq, MAX_CODE_BITS);
  if (!distLens.some((l) => l > 0)) distLens[0] = 1;

  const header = new BitWriter(512);
  writeHuffmanHeader(header, litLens, distLens);
  let bodyBits = 0;
  for (let s = 0; s < NUM_LITLEN_CODES; s++) {
    bodyBits += litFreq[s] * (litLens[s] + (s > 256 ? lengthExtraBits(s - 257) : 0));
  }
  for (let s = 0; s < NUM_DIST_CODES; s++) bodyBits += distFreq[s] * (distLens[s] + bucketExtraBits(s));
  const huffmanBits = header.bitLength + bodyBits;
  const rawLength = block.end - block.start;
  const storedBits = 7 + 32 + rawLength * 8;

  w.writeBits(isFinal ? 1 : 0, 1);
  if (storedBits <= huffmanBits) {
    w.writeBits(BLOCK_STORED, 2);
    w.alignToByte();
    w.writeUint32LE(rawLength);
    w.writeBytes(data.subarray(block.start, block.end));
    return;
  }

  w.writeBits(BLOCK_HUFFMAN, 2);
  writeHuffmanHeader(w, litLens, distLens);
  const litCodes = buildCodes(litLens);
  const distCodes = buildCodes(distLens);
  for (let t = 0; t < count; t++) {
    const d = dist[t];
    if (d === 0) {
      const sym = litLen[t];
      w.writeBits(litCodes[sym], litLens[sym]);
    } else {
      const x = litLen[t] - MIN_MATCH;
      const lc = LENGTH_CODE[x];
      w.writeBits(litCodes[257 + lc], litLens[257 + lc]);
      const lExtra = lengthExtraBits(lc);
      if (lExtra) w.writeBits(x - lengthBase(lc), lExtra);
      const y = d - 1;
      const dc = bucketCode(y);
      w.writeBits(distCodes[dc], distLens[dc]);
      const dExtra = bucketExtraBits(dc);
      if (dExtra) w.writeBits(y - bucketBase(dc), dExtra);
    }
  }
  w.writeBits(litCodes[END_OF_BLOCK], litLens[END_OF_BLOCK]);
}

// ---------------------------------------------------------------------------------------
// Decoding

function readHuffmanTables(r: BitReader): { lit: HuffmanDecoder; dist: HuffmanDecoder } {
  const hlit = r.readBits(6) + 257;
  const hdist = r.readBits(6) + 1;
  const hclen = r.readBits(4) + 4;
  if (hlit > NUM_LITLEN_CODES) throw corrupt("Too many literal/length codes");
  if (hdist > NUM_DIST_CODES) throw corrupt("Too many distance codes");

  const clLens = new Uint8Array(NUM_CL_CODES);
  for (let k = 0; k < hclen; k++) clLens[CL_ORDER[k]] = r.readBits(3);
  const clDecoder = new HuffmanDecoder(clLens);

  const lens = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lens.length) {
    const sym = clDecoder.decode(r);
    if (sym < 16) {
      lens[i++] = sym;
      continue;
    }
    let value = 0;
    let repeat: number;
    if (sym === 16) {
      if (i === 0) throw corrupt("Repeat code with nothing to repeat");
      value = lens[i - 1];
      repeat = 3 + r.readBits(2);
    } else if (sym === 17) {
      repeat = 3 + r.readBits(3);
    } else {
      repeat = 11 + r.readBits(7);
    }
    if (i + repeat > lens.length) throw corrupt("Code length repeat overflows table");
    lens.fill(value, i, i + repeat);
    i += repeat;
  }

  const litLens = new Uint8Array(NUM_LITLEN_CODES);
  litLens.set(lens.subarray(0, hlit));
  if (litLens[END_OF_BLOCK] === 0) throw corrupt("Block has no end-of-block code");
  const distLens = new Uint8Array(NUM_DIST_CODES);
  distLens.set(lens.subarray(hlit));
  return { lit: new HuffmanDecoder(litLens), dist: new HuffmanDecoder(distLens) };
}

function decodeStream(data: Uint8Array, originalSize: number): Uint8Array {
  const out = new Uint8Array(originalSize);
  const r = new BitReader(data);
  let op = 0;
  let isFinal = false;

  while (!isFinal) {
    isFinal = r.readBits(1) === 1;
    const type = r.readBits(2);

    if (type === BLOCK_STORED) {
      const p = r.alignToByte();
      if (p + 4 > data.length) throw corrupt("Unexpected end of compressed data");
      const len = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
      const start = p + 4;
      if (start + len > data.length) throw corrupt("Unexpected end of compressed data");
      if (op + len > originalSize) throw corrupt("Data is longer than expected");
      out.set(data.subarray(start, start + len), op);
      op += len;
      r.seekToByte(start + len);
      continue;
    }
    if (type !== BLOCK_HUFFMAN) throw corrupt(`Unknown block type ${type}`);

    const { lit, dist } = readHuffmanTables(r);
    for (;;) {
      const sym = lit.decode(r);
      if (sym < 256) {
        if (op >= originalSize) throw corrupt("Data is longer than expected");
        out[op++] = sym;
        continue;
      }
      if (sym === END_OF_BLOCK) break;

      const lc = sym - 257;
      const len = lengthBase(lc) + r.readBits(lengthExtraBits(lc)) + MIN_MATCH;
      const dc = dist.decode(r);
      const d = bucketBase(dc) + r.readBits(bucketExtraBits(dc)) + 1;
      if (d > op) throw corrupt("Match points before the start of the data");
      if (op + len > originalSize) throw corrupt("Data is longer than expected");
      let from = op - d;
      if (d >= len && len > 32) {
        out.copyWithin(op, from, from + len);
        op += len;
      } else {
        const end = op + len;
        while (op < end) out[op++] = out[from++];
      }
    }
  }

  if (op !== originalSize) throw corrupt("Data is shorter than expected");
  if (r.alignToByte() !== data.length) throw corrupt("Unexpected data after the end of the stream");
  return out;
}
