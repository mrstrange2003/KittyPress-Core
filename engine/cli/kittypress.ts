#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  type ArchiveInputEntry,
  KittyError,
  createArchive,
  extractArchive,
  isLevel,
  listArchive,
} from "../src/index.ts";

const USAGE = `KittyPress v5 - lossless file compressor

Usage:
  kittypress compress <file-or-folder>... <output.kitty> [--level fast|balanced|max]
  kittypress decompress <archive.kitty> <output-folder> [--force]
  kittypress list <archive.kitty>

Options:
  --level   fast: quickest, balanced: default, max: smallest output but slower
  --force   overwrite files that already exist in the output folder
`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[u]}`;
}

function percentSaved(original: number, packed: number): string {
  if (original === 0) return "0.0%";
  return `${(100 * (1 - packed / original)).toFixed(1)}%`;
}

function collectInputs(inputs: string[]): ArchiveInputEntry[] {
  const entries: ArchiveInputEntry[] = [];
  const add = (abs: string, rel: string): void => {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: "directory", modified: stat.mtimeMs });
      for (const name of fs.readdirSync(abs).sort()) add(path.join(abs, name), `${rel}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ path: rel, kind: "file", data: fs.readFileSync(abs), modified: stat.mtimeMs });
    }
  };
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) throw new Error(`Input not found: ${input}`);
    add(abs, path.basename(abs));
  }
  return entries;
}

function cmdCompress(args: string[], level: string): void {
  if (args.length < 2) throw new Error("compress needs at least one input and an output file");
  if (!isLevel(level)) throw new Error(`Unknown level "${level}" (use fast, balanced or max)`);
  const output = args[args.length - 1];
  const entries = collectInputs(args.slice(0, -1));
  const files = entries.filter((e) => e.kind === "file");
  const originalTotal = files.reduce((s, e) => s + e.data!.length, 0);

  const started = performance.now();
  let lastShown = 0;
  const archive = createArchive(entries, {
    level,
    onProgress: (done, total) => {
      const now = performance.now();
      if (process.stdout.isTTY && total > 0 && now - lastShown > 200) {
        lastShown = now;
        process.stdout.write(`\r  compressing... ${((100 * done) / total).toFixed(0)}%`);
      }
    },
  });
  const seconds = (performance.now() - started) / 1000;
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, archive);

  for (const info of listArchive(archive)) {
    if (info.kind !== "file") continue;
    const how = info.method === 0 ? "  (stored, already compressed)" : "";
    console.log(
      `  + ${info.path}  ${formatBytes(info.originalSize)} -> ${formatBytes(info.storedSize)}` +
        `  (${percentSaved(info.originalSize, info.storedSize)} saved)${how}`,
    );
  }
  console.log(
    `\nCreated ${output}: ${files.length} file(s), ${formatBytes(originalTotal)} -> ${formatBytes(archive.length)}` +
      ` (${percentSaved(originalTotal, archive.length)} saved) in ${seconds.toFixed(2)}s`,
  );
}

function cmdDecompress(args: string[], force: boolean): void {
  if (args.length !== 2) throw new Error("decompress needs an archive and an output folder");
  const [archivePath, outDir] = args;
  const archive = fs.readFileSync(archivePath);
  const started = performance.now();
  const entries = extractArchive(archive);
  const root = path.resolve(outDir);

  const targets = entries.map((e) => {
    const target = path.resolve(root, ...e.path.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside output folder: ${e.path}`);
    if (e.kind === "file" && fs.existsSync(target) && !force) {
      throw new Error(`${target} already exists (use --force to overwrite)`);
    }
    return target;
  });

  fs.mkdirSync(root, { recursive: true });
  entries.forEach((e, i) => {
    const target = targets[i];
    if (e.kind === "directory") {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
    }
    if (e.modified) fs.utimesSync(target, new Date(e.modified), new Date(e.modified));
  });
  const files = entries.filter((e) => e.kind === "file");
  const total = files.reduce((s, e) => s + e.originalSize, 0);
  const seconds = (performance.now() - started) / 1000;
  console.log(`Extracted ${files.length} file(s), ${formatBytes(total)} to ${root} in ${seconds.toFixed(2)}s (all checksums OK)`);
}

function cmdList(args: string[]): void {
  if (args.length !== 1) throw new Error("list needs an archive");
  const entries = listArchive(fs.readFileSync(args[0]));
  for (const e of entries) {
    if (e.kind === "directory") console.log(`  ${e.path}/`);
    else console.log(`  ${e.path}  ${formatBytes(e.originalSize)} -> ${formatBytes(e.storedSize)}`);
  }
}

function main(argv: string[]): number {
  const positional: string[] = [];
  let level = "balanced";
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--level" || a === "-l") level = argv[++i] ?? "";
    else if (a.startsWith("--level=")) level = a.slice("--level=".length);
    else if (a === "--force" || a === "-f") force = true;
    else if (a === "--help" || a === "-h") positional.length = 0;
    else positional.push(a);
  }
  const [command, ...rest] = positional;
  try {
    if (command === "compress") cmdCompress(rest, level);
    else if (command === "decompress" || command === "extract") cmdDecompress(rest, force);
    else if (command === "list") cmdList(rest);
    else {
      console.log(USAGE);
      return command ? 1 : 0;
    }
    return 0;
  } catch (err) {
    const message = err instanceof KittyError || err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
