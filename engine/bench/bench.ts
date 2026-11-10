// Compares KittyPress with gzip (the algorithm inside .zip/.gz) on real files.
// Usage: node bench/bench.ts [file...] [--levels fast,balanced,max]
// With no files, uses ../samples plus generated CSV/JSON data.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compress, decompress, type Level } from "../src/index.ts";

interface Input {
  name: string;
  data: Uint8Array;
}

function generatedInputs(): Input[] {
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const cities = ["Mumbai", "Delhi", "Bengaluru", "Chennai", "Kolkata", "Pune", "Hyderabad", "Jaipur"];
  const names = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Ananya", "Vihaan", "Isha", "Arjun", "Sara"];
  let csv = "id,name,city,age,score,joined,active\n";
  for (let i = 1; i <= 60_000; i++) {
    csv += `${i},${names[(rand() * names.length) | 0]},${cities[(rand() * cities.length) | 0]},` +
      `${18 + ((rand() * 50) | 0)},${(rand() * 100).toFixed(2)},2024-${String(1 + ((rand() * 12) | 0)).padStart(2, "0")}-` +
      `${String(1 + ((rand() * 28) | 0)).padStart(2, "0")},${rand() < 0.8}\n`;
  }
  const events = [];
  for (let i = 0; i < 25_000; i++) {
    events.push({
      ts: 1_700_000_000_000 + i * 1371,
      level: rand() < 0.9 ? "info" : "error",
      user: { id: (rand() * 5000) | 0, name: names[(rand() * names.length) | 0] },
      action: ["login", "upload", "compress", "download", "logout"][(rand() * 5) | 0],
      bytes: (rand() * 1e7) | 0,
    });
  }
  const enc = new TextEncoder();
  return [
    { name: "generated.csv", data: enc.encode(csv) },
    { name: "generated.json", data: enc.encode(JSON.stringify(events, null, 2)) },
  ];
}

function fileInputs(paths: string[]): Input[] {
  const out: Input[] = [];
  for (const p of paths) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        const full = path.join(p, name);
        if (fs.statSync(full).isFile()) out.push({ name, data: new Uint8Array(fs.readFileSync(full)) });
      }
    } else {
      out.push({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) });
    }
  }
  return out;
}

function time<T>(fn: () => T): [T, number] {
  const start = performance.now();
  const result = fn();
  return [result, (performance.now() - start) / 1000];
}

const pct = (packed: number, original: number) => `${((100 * packed) / original).toFixed(1)}%`.padStart(7);
const mbps = (bytes: number, s: number) => `${(bytes / 1e6 / Math.max(s, 1e-6)).toFixed(0)}`.padStart(5);

function main(): void {
  const args = process.argv.slice(2);
  let levels: Level[] = ["fast", "balanced", "max"];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--levels") levels = args[++i].split(",") as Level[];
    else paths.push(args[i]);
  }
  const inputs = paths.length
    ? fileInputs(paths)
    : [...fileInputs([path.resolve(import.meta.dirname, "../../samples")]), ...generatedInputs()];

  // Warm up the JIT so the first files' speeds aren't dominated by compilation.
  const warm = generatedInputs()[0].data.subarray(0, 1 << 20);
  for (const level of levels) {
    const p = compress(warm, { level });
    decompress(p.method, p.data, warm.length);
  }

  const header =
    "file".padEnd(26) + "size".padStart(10) + "  gzip-6  gzip-9" +
    levels.map((l) => `  ${("kp-" + l).padStart(11)}`).join("") +
    "   gz6 MB/s  kp MB/s  kp-unpack MB/s";
  console.log("Compressed size as % of original (lower is better)\n");
  console.log(header);
  console.log("-".repeat(header.length));

  const totals = { orig: 0, gz6: 0, gz9: 0, kp: new Map<Level, number>() };
  for (const { name, data } of inputs) {
    const [gz6, gz6Time] = time(() => zlib.gzipSync(data, { level: 6 }));
    const gz9 = zlib.gzipSync(data, { level: 9 });
    totals.orig += data.length;
    totals.gz6 += gz6.length;
    totals.gz9 += gz9.length;

    let line = name.slice(0, 25).padEnd(26) + `${(data.length / 1024).toFixed(0)} KB`.padStart(10) +
      ` ${pct(gz6.length, data.length)} ${pct(gz9.length, data.length)}`;
    let speed = "";
    for (const level of levels) {
      const [packed, packTime] = time(() => compress(data, { level }));
      const [restored, unpackTime] = time(() => decompress(packed.method, packed.data, data.length));
      if (Buffer.compare(Buffer.from(restored), Buffer.from(data)) !== 0) throw new Error(`ROUND TRIP FAILED: ${name} ${level}`);
      totals.kp.set(level, (totals.kp.get(level) ?? 0) + packed.data.length);
      line += `  ${pct(packed.data.length, data.length).padStart(11)}`;
      if (level === "balanced" || levels.length === 1) {
        speed = `   ${mbps(data.length, gz6Time).padStart(8)}  ${mbps(data.length, packTime).padStart(7)}  ${mbps(data.length, unpackTime).padStart(14)}`;
      }
    }
    console.log(line + speed);
  }
  console.log("-".repeat(header.length));
  console.log(
    "TOTAL".padEnd(26) + `${(totals.orig / 1024).toFixed(0)} KB`.padStart(10) +
      ` ${pct(totals.gz6, totals.orig)} ${pct(totals.gz9, totals.orig)}` +
      levels.map((l) => `  ${pct(totals.kp.get(l)!, totals.orig).padStart(11)}`).join(""),
  );
  console.log("\nAll round trips verified byte-for-byte.");
}

main();
