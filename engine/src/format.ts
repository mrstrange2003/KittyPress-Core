// Constants shared by the compressor and decompressor. Changing any of these changes
// the compressed format, so bump FORMAT_VERSION in archive.ts if you do.

export const MIN_MATCH = 3;
export const MAX_MATCH = 1026;
export const WINDOW_SIZE = 1 << 20;
export const MAX_DISTANCE = WINDOW_SIZE - 1;

export const END_OF_BLOCK = 256;
export const NUM_LENGTH_CODES = 40;
export const NUM_LITLEN_CODES = 257 + NUM_LENGTH_CODES;
export const NUM_DIST_CODES = 40;
export const MAX_CODE_BITS = 15;

export const NUM_CL_CODES = 19;
export const MAX_CL_BITS = 7;
export const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export const BLOCK_STORED = 0;
export const BLOCK_HUFFMAN = 1;

// Match lengths (minus MIN_MATCH) are sent as a code plus extra bits: 0-15 are their own
// code (short matches are the most common), above that there are four codes per power of two.
export function lengthCode(x: number): number {
  if (x < 16) return x;
  const n = 31 - Math.clz32(x);
  return 16 + ((n - 4) << 2) + ((x >>> (n - 2)) & 3);
}

export function lengthExtraBits(code: number): number {
  return code < 16 ? 0 : ((code - 16) >> 2) + 2;
}

export function lengthBase(code: number): number {
  if (code < 16) return code;
  return (4 | ((code - 16) & 3)) << (((code - 16) >> 2) + 2);
}

// Distances (minus 1) use the same idea with coarser buckets: 0-3 are their own code, above
// that there are two codes per power of two.
export function bucketCode(x: number): number {
  if (x < 4) return x;
  const n = 31 - Math.clz32(x);
  return 2 * n + ((x >>> (n - 1)) & 1);
}

export function bucketExtraBits(code: number): number {
  return code < 4 ? 0 : (code >>> 1) - 1;
}

export function bucketBase(code: number): number {
  if (code < 4) return code;
  return (2 | (code & 1)) << ((code >>> 1) - 1);
}
