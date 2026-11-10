import type { BitReader } from "./bitio.ts";
import { corrupt } from "./errors.ts";

/**
 * Computes Huffman code lengths for the given symbol frequencies, with no code longer than `maxLen`.
 * Symbols with frequency 0 get length 0 (no code). A lone used symbol gets length 1.
 */
export function buildCodeLengths(freqs: ArrayLike<number>, maxLen: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }

  // Leaves sorted by ascending frequency; internal nodes are created in non-decreasing
  // weight order, so two queues give an O(n) Huffman construction.
  syms.sort((a, b) => freqs[a] - freqs[b] || a - b);
  const m = syms.length;
  const weight = new Float64Array(2 * m - 1);
  const parent = new Int32Array(2 * m - 1);
  for (let i = 0; i < m; i++) weight[i] = freqs[syms[i]];
  let leaf = 0;
  let head = m;
  let tail = m;
  const pick = (): number => {
    if (leaf < m && (head === tail || weight[leaf] <= weight[head])) return leaf++;
    return head++;
  };
  for (let k = 0; k < m - 1; k++) {
    const a = pick();
    const b = pick();
    weight[tail] = weight[a] + weight[b];
    parent[a] = tail;
    parent[b] = tail;
    tail++;
  }

  const depth = new Uint16Array(2 * m - 1);
  for (let node = 2 * m - 3; node >= 0; node--) depth[node] = depth[parent[node]] + 1;

  const len = new Int32Array(m);
  let overflow = false;
  for (let i = 0; i < m; i++) {
    len[i] = depth[i];
    if (len[i] > maxLen) {
      len[i] = maxLen;
      overflow = true;
    }
  }

  if (overflow) {
    // Clamping broke the Kraft inequality; lengthen the least frequent codes that still
    // have room until it holds, then shorten the most frequent codes while space remains.
    const cap = 2 ** maxLen;
    let kraft = 0;
    for (let i = 0; i < m; i++) kraft += 2 ** (maxLen - len[i]);
    while (kraft > cap) {
      for (let i = 0; i < m; i++) {
        if (len[i] < maxLen) {
          kraft -= 2 ** (maxLen - len[i] - 1);
          len[i]++;
          break;
        }
      }
    }
    for (let i = m - 1; i >= 0; i--) {
      while (len[i] > 1 && kraft + 2 ** (maxLen - len[i]) <= cap) {
        kraft += 2 ** (maxLen - len[i]);
        len[i]--;
      }
    }
  }

  for (let i = 0; i < m; i++) lengths[syms[i]] = len[i];
  return lengths;
}

function reverseBits(code: number, length: number): number {
  let r = 0;
  for (let i = 0; i < length; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

/**
 * Assigns canonical Huffman codes from code lengths. Codes are returned bit-reversed,
 * ready to be written least-significant-bit first.
 */
export function buildCodes(lengths: Uint8Array): Uint32Array {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(maxLen + 2);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym];
    if (l) codes[sym] = reverseBits(nextCode[l]++, l);
  }
  return codes;
}

/** Table-driven decoder for a canonical Huffman code. */
export class HuffmanDecoder {
  private readonly table: Uint32Array;
  private readonly bits: number;

  /** Throws CORRUPT if the lengths don't describe a valid prefix code. */
  constructor(lengths: Uint8Array) {
    let maxLen = 0;
    let used = 0;
    let kraft = 0;
    for (let i = 0; i < lengths.length; i++) {
      const l = lengths[i];
      if (!l) continue;
      used++;
      if (l > maxLen) maxLen = l;
      kraft += 2 ** -l;
    }
    if (used === 0) throw corrupt("Empty Huffman table");
    if (kraft > 1) throw corrupt("Over-subscribed Huffman table");

    this.bits = maxLen;
    const size = 1 << maxLen;
    this.table = new Uint32Array(size);
    const codes = buildCodes(lengths);
    for (let sym = 0; sym < lengths.length; sym++) {
      const l = lengths[sym];
      if (!l) continue;
      const entry = (sym << 4) | l;
      for (let j = codes[sym]; j < size; j += 1 << l) this.table[j] = entry;
    }
  }

  decode(reader: BitReader): number {
    const entry = this.table[reader.peek(this.bits)];
    const l = entry & 15;
    if (l === 0) throw corrupt("Invalid Huffman code");
    reader.consume(l);
    return entry >>> 4;
  }
}
