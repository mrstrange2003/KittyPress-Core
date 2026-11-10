// Tries different match-finder settings on a set of files and prints total size and speed.
// Settings come from SWEEP as "chain,nice,lazy,good,windowBits,hashBits" entries separated by ";".
// Usage (PowerShell): $env:SWEEP = "32,128,16,8,18,16;256,258,128,32,20,17"; node bench/sweep.ts <file>...
import fs from "node:fs";
import zlib from "node:zlib";
import { compress } from "../src/index.ts";
import { LEVELS, type MatchParams } from "../src/lz77.ts";

const files = process.argv.slice(2).map((p) => new Uint8Array(fs.readFileSync(p)));
const total = files.reduce((s, f) => s + f.length, 0);

const gz = (level: number) => {
  const t = performance.now();
  const size = files.reduce((s, f) => s + zlib.gzipSync(f, { level }).length, 0);
  return { size, secs: (performance.now() - t) / 1000 };
};

const report = (label: string, size: number, secs: number) =>
  console.log(`${label.padEnd(44)} ${((100 * size) / total).toFixed(2).padStart(6)}%  ${(total / 1e6 / secs).toFixed(1).padStart(6)} MB/s`);

for (const level of [1, 6, 9]) {
  const r = gz(level);
  report(`gzip -${level}`, r.size, r.secs);
}

const p = (maxChain: number, niceLength: number, lazyLimit: number, goodLength: number, windowBits: number, hashBits: number): [string, MatchParams] => [
  `c${maxChain} n${niceLength} lz${lazyLimit} g${goodLength} w${windowBits} h${hashBits}`,
  { maxChain, niceLength, lazyLimit, goodLength, windowBits, hashBits },
];
const candidates = (process.env.SWEEP ?? "")
  .split(";")
  .filter(Boolean)
  .map((s) => p(...(s.split(",").map(Number) as [number, number, number, number, number, number])));

for (const [label, params] of candidates) {
  LEVELS.balanced = params;
  compress(files[0].subarray(0, 200_000), { level: "balanced" });
  const t = performance.now();
  const size = files.reduce((s, f) => s + compress(f, { level: "balanced" }).data.length, 0);
  report(label, size, (performance.now() - t) / 1000);
}
