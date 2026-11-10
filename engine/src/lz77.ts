import { MAX_DISTANCE, MAX_MATCH, MIN_MATCH, WINDOW_SIZE } from "./format.ts";

export type Level = "fast" | "balanced" | "max";

export interface MatchParams {
  /** How many earlier positions with the same hash to try per position. */
  maxChain: number;
  /** Stop searching once a match this long is found. */
  niceLength: number;
  /** Look one byte ahead for a better match unless the current one is at least this long (0 = greedy). */
  lazyLimit: number;
  /** Search a quarter as hard when the current match is already this long. */
  goodLength: number;
  /** log2 of how far back to look. Smaller windows are faster (they fit in CPU cache). */
  windowBits: number;
  /** log2 of the hash table size. */
  hashBits: number;
}

export const LEVELS: Record<Level, MatchParams> = {
  fast: { maxChain: 8, niceLength: 32, lazyLimit: 0, goodLength: 4, windowBits: 16, hashBits: 15 },
  balanced: { maxChain: 32, niceLength: 128, lazyLimit: 16, goodLength: 8, windowBits: 18, hashBits: 16 },
  max: { maxChain: 256, niceLength: 258, lazyLimit: 128, goodLength: 32, windowBits: 20, hashBits: 17 },
};

export function isLevel(value: unknown): value is Level {
  return value === "fast" || value === "balanced" || value === "max";
}

const HASH3_BITS = 14;
const HASH_MULTIPLIER = 0x9e3779b1;
const BLOCK_TOKEN_CAPACITY = 1 << 14;
const BLOCK_MAX_BYTES = 1 << 20;
/** Matches of length 3 or 4 that are farther away than this cost more than literals. */
const MAX_DIST_LEN3 = 4096;
const MAX_DIST_LEN4 = 65536;

/** A run of LZ77 tokens covering input bytes [start, end). */
export class TokenBlock {
  /** Literal byte when `dist` is 0, otherwise the match length. */
  readonly litLen = new Uint16Array(BLOCK_TOKEN_CAPACITY);
  /** Match distance, or 0 for a literal. */
  readonly dist = new Uint32Array(BLOCK_TOKEN_CAPACITY);
  count = 0;
  start = 0;
  end = 0;
}

/**
 * Splits `data` into LZ77 tokens and hands them over in blocks. The same TokenBlock object
 * is reused, so `onBlock` must finish with it before returning. The last call has
 * `isLast` set (and may contain zero tokens).
 *
 * Kept as one big function with plain locals: V8 optimizes this far better than the same
 * logic split into small closures.
 */
export function tokenize(
  data: Uint8Array,
  level: Level,
  onBlock: (block: TokenBlock, isLast: boolean) => void,
): void {
  const { maxChain, niceLength, lazyLimit, goodLength, windowBits, hashBits } = LEVELS[level];
  const greedy = lazyLimit === 0;
  const n = data.length;
  const block = new TokenBlock();
  const litLen = block.litLen;
  const distArr = block.dist;

  const maxWindow = Math.min(1 << windowBits, WINDOW_SIZE);
  let windowSize = 1024;
  while (windowSize < n && windowSize < maxWindow) windowSize <<= 1;
  const mask = windowSize - 1;
  const maxDistance = Math.min(MAX_DISTANCE, maxWindow - 1);
  // Hash chains are keyed on 4 bytes, which keeps them short and full of real candidates.
  // head3 remembers the latest position per 3-byte hash to catch nearby 3-byte matches.
  const head = new Int32Array(1 << hashBits).fill(-1);
  const prev = new Int32Array(windowSize);
  const head3 = new Int32Array(1 << HASH3_BITS).fill(-1);
  const hashShift = 32 - hashBits;
  const hash3Shift = 32 - HASH3_BITS;
  const lastHashable = n - MIN_MATCH;
  const lastChained = n - 4;

  let count = 0;
  let blockStart = 0;
  let emittedEnd = 0;
  let prevLen = 0;
  let prevDist = 0;
  let pending = false;
  let i = 0;

  while (i < n) {
    // Record position i in the hash tables.
    let chainStart = -1;
    let cand3 = -1;
    if (i <= lastHashable) {
      const v3 = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
      const h3 = Math.imul(v3, HASH_MULTIPLIER) >>> hash3Shift;
      cand3 = head3[h3];
      head3[h3] = i;
      if (i <= lastChained) {
        const h = Math.imul(v3 | (data[i + 3] << 24), HASH_MULTIPLIER) >>> hashShift;
        chainStart = head[h];
        prev[i & mask] = chainStart;
        head[h] = i;
      }
    }

    // Find the longest match at i that beats the pending one.
    let curLen = 0;
    let curDist = 0;
    const minLen = prevLen > MIN_MATCH - 1 ? prevLen : MIN_MATCH - 1;
    const maxLen = n - i < MAX_MATCH ? n - i : MAX_MATCH;
    if (i <= lastHashable && (greedy || prevLen < lazyLimit) && minLen < maxLen) {
      let chain = minLen >= goodLength ? maxChain >> 2 : maxChain;
      const nice = niceLength < maxLen ? niceLength : maxLen;
      const limit = i - maxDistance;
      const first = data[i];
      let best = minLen;
      let scanEnd = data[i + best];
      let scanEnd1 = data[i + best - 1];
      let cur = chainStart;
      while (cur >= limit && cur >= 0 && chain-- > 0) {
        if (data[cur + best] === scanEnd && data[cur + best - 1] === scanEnd1 && data[cur] === first) {
          let len = 1;
          while (len < maxLen && data[cur + len] === data[i + len]) len++;
          if (len > best) {
            const dist = i - cur;
            // Candidates come nearest-first; a farther one must be long enough to pay for the
            // extra distance bits (roughly 1 bit per doubling vs ~6 bits per extra byte).
            const worthDistance =
              curLen === 0 || (len - best) * 6 > Math.clz32(curDist) - Math.clz32(dist);
            if (worthDistance && (len > 4 || dist <= (len === 4 ? MAX_DIST_LEN4 : MAX_DIST_LEN3))) {
              best = len;
              curLen = len;
              curDist = dist;
              if (len >= nice) break;
              scanEnd = data[i + best];
              scanEnd1 = data[i + best - 1];
            }
          }
        }
        cur = prev[cur & mask];
      }
      if (curLen === 0 && minLen < MIN_MATCH && cand3 >= 0 && i - cand3 <= MAX_DIST_LEN3) {
        if (data[cand3] === first && data[cand3 + 1] === data[i + 1] && data[cand3 + 2] === data[i + 2]) {
          let len = MIN_MATCH;
          while (len < maxLen && data[cand3 + len] === data[i + len]) len++;
          curLen = len;
          curDist = i - cand3;
        }
      }
    }

    // Emit at most one token. In lazy mode a match found at i-1 is only used if position i
    // doesn't have a longer one.
    let insertFrom = 0;
    let insertTo = 0;
    if (greedy) {
      if (curLen >= MIN_MATCH) {
        litLen[count] = curLen;
        distArr[count++] = curDist;
        insertFrom = i + 1;
        insertTo = i + curLen;
        i += curLen;
      } else {
        litLen[count] = data[i];
        distArr[count++] = 0;
        i++;
      }
      emittedEnd = i;
    } else if (pending && prevLen >= MIN_MATCH && curLen <= prevLen) {
      const start = i - 1;
      litLen[count] = prevLen;
      distArr[count++] = prevDist;
      insertFrom = i + 1;
      insertTo = start + prevLen;
      i = start + prevLen;
      emittedEnd = i;
      pending = false;
      prevLen = 0;
    } else {
      if (pending) {
        litLen[count] = data[i - 1];
        distArr[count++] = 0;
        emittedEnd = i;
      }
      pending = true;
      prevLen = curLen;
      prevDist = curDist;
      i++;
    }

    // Positions covered by a match still go into the hash tables for later searches.
    if (insertTo > lastHashable + 1) insertTo = lastHashable + 1;
    for (let k = insertFrom; k < insertTo; k++) {
      const v3 = data[k] | (data[k + 1] << 8) | (data[k + 2] << 16);
      head3[Math.imul(v3, HASH_MULTIPLIER) >>> hash3Shift] = k;
      if (k <= lastChained) {
        const h = Math.imul(v3 | (data[k + 3] << 24), HASH_MULTIPLIER) >>> hashShift;
        prev[k & mask] = head[h];
        head[h] = k;
      }
    }

    if (count === BLOCK_TOKEN_CAPACITY || emittedEnd - blockStart >= BLOCK_MAX_BYTES) {
      block.count = count;
      block.start = blockStart;
      block.end = emittedEnd;
      onBlock(block, false);
      count = 0;
      blockStart = emittedEnd;
    }
  }

  if (pending) {
    litLen[count] = data[n - 1];
    distArr[count++] = 0;
    emittedEnd = n;
  }
  block.count = count;
  block.start = blockStart;
  block.end = emittedEnd;
  onBlock(block, true);
}
