import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { BitReader } from "../src/bitio.ts";
import { compress, crc32, decompress, KittyError, type Level, METHOD_KITTY_LZ, METHOD_STORED } from "../src/index.ts";
import { HuffmanDecoder, buildCodeLengths, buildCodes } from "../src/huffman.ts";
import { BitWriter } from "../src/bitio.ts";
import {
  MAX_DISTANCE,
  MAX_MATCH,
  MIN_MATCH,
  NUM_DIST_CODES,
  NUM_LENGTH_CODES,
  bucketBase,
  bucketCode,
  bucketExtraBits,
  lengthBase,
  lengthCode,
  lengthExtraBits,
} from "../src/format.ts";
import { concat, equalBytes, randomBytes, rng, structuredMix, textLike } from "./helpers.ts";

const LEVELS: Level[] = ["fast", "balanced", "max"];

function roundTrip(data: Uint8Array, level: Level): { method: number; size: number } {
  const packed = compress(data, { level });
  const restored = decompress(packed.method, packed.data, data.length);
  assert.ok(equalBytes(restored, data), `round trip failed (level ${level}, ${data.length} bytes)`);
  return { method: packed.method, size: packed.data.length };
}

describe("crc32", () => {
  it("matches zlib for many lengths", () => {
    for (const n of [0, 1, 3, 4, 5, 7, 8, 100, 4097, 100_000]) {
      const d = randomBytes(n, n + 1);
      assert.equal(crc32(d), zlib.crc32(d));
    }
  });

  it("supports running checksums", () => {
    const d = randomBytes(10_000, 7);
    assert.equal(crc32(d.subarray(3000), crc32(d.subarray(0, 3000))), crc32(d));
  });
});

describe("huffman", () => {
  it("limits code lengths and keeps a valid prefix code", () => {
    // Fibonacci frequencies produce a maximally deep tree without a limit.
    const freqs = [1, 1];
    while (freqs.length < 40) freqs.push(freqs[freqs.length - 1] + freqs[freqs.length - 2]);
    for (const maxLen of [7, 15]) {
      const lens = buildCodeLengths(freqs, maxLen);
      let kraft = 0;
      for (const l of lens) {
        assert.ok(l >= 1 && l <= maxLen);
        kraft += 2 ** -l;
      }
      assert.ok(kraft <= 1 + 1e-12);
    }
  });

  it("encodes and decodes random symbol streams", () => {
    const r = rng(42);
    for (let trial = 0; trial < 50; trial++) {
      const nsym = 2 + Math.floor(r() * 300);
      const freqs = Array.from({ length: nsym }, () => (r() < 0.3 ? 0 : Math.floor(r() ** 4 * 10000)));
      freqs[0] ||= 1;
      const lens = buildCodeLengths(freqs, 15);
      const codes = buildCodes(lens);
      const used = freqs.flatMap((f, s) => (f > 0 ? [s] : []));
      const msg = Array.from({ length: 2000 }, () => used[Math.floor(r() * used.length)]);
      const w = new BitWriter();
      for (const s of msg) w.writeBits(codes[s], lens[s]);
      const reader = new BitReader(w.finish());
      const dec = new HuffmanDecoder(lens);
      for (const s of msg) assert.equal(dec.decode(reader), s);
    }
  });
});

describe("length and distance codes", () => {
  it("map every value to a code and back", () => {
    for (let x = 0; x <= MAX_MATCH - MIN_MATCH; x++) {
      const c = lengthCode(x);
      assert.ok(c < NUM_LENGTH_CODES);
      const off = x - lengthBase(c);
      assert.ok(off >= 0 && off < 2 ** lengthExtraBits(c), `length ${x}`);
    }
    for (let x = 0; x < MAX_DISTANCE; x++) {
      const c = bucketCode(x);
      assert.ok(c < NUM_DIST_CODES);
      const off = x - bucketBase(c);
      assert.ok(off >= 0 && off < 2 ** bucketExtraBits(c), `distance ${x}`);
    }
  });
});

describe("compress/decompress round trips", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["1 byte", Uint8Array.of(42)],
    ["2 bytes", Uint8Array.of(1, 2)],
    ["3 identical bytes", Uint8Array.of(7, 7, 7)],
    ["4 identical bytes", Uint8Array.of(7, 7, 7, 7)],
    ["all byte values", Uint8Array.from({ length: 256 * 40 }, (_, i) => i & 0xff)],
    ["3 MB of zeros", new Uint8Array(3 << 20)],
    ["text 2.5 MB", textLike(2_500_000, 1)],
    ["structured binary 3 MB", structuredMix(3_000_000, 2)],
    ["random 300 KB", randomBytes(300_000, 3)],
    ["text with random chunks", concat(textLike(200_000, 4), randomBytes(150_000, 5), textLike(200_000, 6))],
    ["repeat at distance 600 KB", (() => { const a = randomBytes(600_000, 8); return concat(a, a); })()],
    ["repeat just inside window", (() => { const a = randomBytes((1 << 20) - 1, 9); return concat(a, a.subarray(0, 50_000)); })()],
    ["repeat just outside window", (() => { const a = randomBytes(1 << 20, 10); return concat(a, a.subarray(0, 50_000)); })()],
    ["float32 sine wave", new Uint8Array(Float32Array.from({ length: 200_000 }, (_, i) => Math.sin(i / 50)).buffer)],
    ["many tokens per block", Uint8Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251 < 120 ? i % 3 : (i * 31) & 0xff)],
  ];

  for (const [name, data] of cases) {
    it(name, () => {
      for (const level of LEVELS) roundTrip(data, level);
    });
  }

  it("shrinks compressible data well", () => {
    assert.ok(roundTrip(textLike(1_000_000, 11), "balanced").size < 350_000);
    assert.ok(roundTrip(new Uint8Array(1 << 20), "balanced").size < 2000);
  });

  it("stores incompressible data without growing it", () => {
    const small = randomBytes(100_000, 12);
    const r1 = roundTrip(small, "balanced");
    assert.equal(r1.method, METHOD_STORED);
    const big = randomBytes(3_000_000, 13);
    assert.equal(roundTrip(big, "balanced").method, METHOD_STORED);
  });

  it("uses the far window to find a long-distance repeat", () => {
    const a = randomBytes(700_000, 14);
    const r = roundTrip(concat(a, a), "max");
    assert.equal(r.method, METHOD_KITTY_LZ);
    assert.ok(r.size < 720_000, `size ${r.size}`);

    // "balanced" looks back 256 KB, so keep the repeat just inside that.
    const unique = randomBytes(100_000, 16);
    const middle = textLike(150_000, 17);
    const without = roundTrip(concat(unique, middle), "balanced").size;
    const withRepeat = roundTrip(concat(unique, middle, unique), "balanced").size;
    assert.ok(withRepeat < without + 2_000, `without ${without}, with repeat ${withRepeat}`);
  });

  it("survives random fuzz inputs", () => {
    const r = rng(1234);
    for (let trial = 0; trial < 150; trial++) {
      const n = Math.floor(r() ** 2 * 250_000);
      const data = r() < 0.5 ? structuredMix(n, trial) : concat(textLike(n >> 1, trial), structuredMix(n >> 1, trial + 999));
      roundTrip(data, LEVELS[trial % 3]);
    }
  });

  it("reports progress up to the full size", () => {
    const data = textLike(3_000_000, 15);
    let last = 0;
    compress(data, { onProgress: (done, total) => { assert.ok(done >= last && total === data.length); last = done; } });
    assert.equal(last, data.length);
  });
});

describe("damaged compressed streams", () => {
  it("never crash with anything other than KittyError", () => {
    const data = concat(textLike(120_000, 21), structuredMix(80_000, 22));
    const { data: packed } = compress(data);
    const r = rng(99);
    for (let trial = 0; trial < 400; trial++) {
      const bad = packed.slice();
      const mode = trial % 3;
      let input = bad;
      if (mode === 0) bad[Math.floor(r() * bad.length)] ^= 1 << Math.floor(r() * 8);
      else if (mode === 1) input = bad.subarray(0, Math.floor(r() * bad.length));
      else for (let k = 0; k < 8; k++) bad[Math.floor(r() * bad.length)] = (r() * 256) | 0;
      try {
        decompress(METHOD_KITTY_LZ, input, data.length);
      } catch (err) {
        assert.ok(err instanceof KittyError, `unexpected error type: ${err}`);
      }
    }
  });
});
