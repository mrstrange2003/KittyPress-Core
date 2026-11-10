/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 256) | 0;
  return out;
}

const WORDS =
  "the quick brown fox jumps over lazy dog kitty press compress data file archive stream byte " +
  "huffman code tree window match length distance block table header literal symbol bits frequency " +
  "function return const let while for if else value number string array object class import export";

/** English-ish text with a skewed word distribution, punctuation and line breaks. */
export function textLike(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  const words = WORDS.split(" ");
  let s = "";
  while (s.length < n) {
    const w = words[Math.floor(r() ** 2 * words.length)];
    s += w;
    const p = r();
    s += p < 0.05 ? ".\n" : p < 0.12 ? ", " : " ";
  }
  return new TextEncoder().encode(s.slice(0, n));
}

/** Binary data shaped like real files: runs, copies of earlier data, noise and counters. */
export function structuredMix(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const kind = r();
    const len = Math.min(n - i, 1 + Math.floor(r() ** 3 * 4000));
    if (kind < 0.2) {
      out.fill((r() * 256) | 0, i, i + len);
    } else if (kind < 0.55 && i > 0) {
      const dist = 1 + Math.floor(r() ** 2 * Math.min(i, 2_000_000));
      for (let k = 0; k < len; k++) out[i + k] = out[i + k - dist];
    } else if (kind < 0.75) {
      for (let k = 0; k < len; k++) out[i + k] = (r() * 256) | 0;
    } else {
      const start = (r() * 256) | 0;
      const step = 1 + ((r() * 4) | 0);
      for (let k = 0; k < len; k++) out[i + k] = (start + k * step) & 0xff;
    }
    i += len;
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
