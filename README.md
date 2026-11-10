# KittyPress

KittyPress is a lossless compressor. It packs files and folders into one `.kitty` archive and unpacks them byte for byte identical to the originals.

The same TypeScript engine runs in two places:

- a web app, which compresses and extracts in the browser (files are never uploaded)
- a command-line tool for Node.js

Archives use format version 5 (`KP05`). Archives made by the old C++ KittyPress (`KP01` through `KP04`, kept in `legacy-cpp/` for reference) cannot be opened.

## Requirements

- [Node.js](https://nodejs.org/) 22.18 or newer (includes npm)
- a current browser for the web app: Chrome, Edge, Firefox, or Safari

Check your Node version with `node -v`.

## Setup

From the repository root:

```sh
npm install
```

That installs the command-line tool, the web app, and the test runner. No global packages are required.

## Run the tests

```sh
npm test
npm run typecheck
```

`npm test` round-trips the compressor on empty files, random data, damaged archives, and the files in `samples/`. It also checks that multi-file downloads build a valid `.zip`. `npm run typecheck` checks the engine and the web app without emitting files.

## Web app

```sh
npm run dev
```

Open the local address Vite prints. The default is <http://localhost:5173>. If that port is already in use, Vite picks another one and prints it.

Try a round trip:

1. On **Compress**, click **Try a sample file** (or drop your own files or a folder).
2. Leave the level on **Balanced** and click **Compress**.
3. Click **Download .kitty**.
4. Switch to **Extract**, drop that `.kitty` file, and download the file again.

**Fast** finishes sooner and the archive is a little larger. **Smallest** spends longer to squeeze the archive down further. Photos, video, and zip files are usually stored as-is, because they are already compressed.

The page shows a progress bar and, when it finishes, how much smaller the archive is. Extraction checks every file's checksum before offering a download. **Save to folder** is available in Chrome and Edge. **Download all as .zip** keeps folder paths and works in every browser.

### Production build

```sh
npm run build
npm run preview
```

`npm run build` writes a static site to `web/dist`. `npm run preview` serves that folder locally (default <http://localhost:4173>). The site has no backend. Hosting `web/dist` works when it is the root of the site. If it will live in a subpath, set `base` in `web/vite.config.ts` before building.

## Command line

```sh
npm run kp -- compress <file-or-folder>... <output.kitty>
npm run kp -- list <archive.kitty>
npm run kp -- decompress <archive.kitty> <output-folder>
```

A round trip of the included samples:

```sh
npm run kp -- compress samples samples.kitty
npm run kp -- list samples.kitty
npm run kp -- decompress samples.kitty restored
```

`samples.kitty` is ignored by git. Extraction refuses to overwrite files that are already in the output folder unless you pass `--force`.

Levels are `--level fast`, `--level balanced` (the default), and `--level max`. `max` is the same setting as **Smallest** in the web app.

```sh
npm run kp -- compress samples samples.kitty --level max
```

## Benchmark

`npm run bench` compresses `samples/` plus a generated CSV and JSON file, compares the size with gzip, and checks that every file round-trips. Ratios below are compressed size as a percentage of the original (lower is better). gzip is the method used by `.zip` and `.gz` files. Speeds are printed by the benchmark and depend on the computer.

| File | gzip -6 | gzip -9 | KittyPress fast | KittyPress balanced | KittyPress max |
|---|---|---|---|---|---|
| test.txt | 2.7% | 2.7% | 2.3% | 2.3% | 2.3% |
| generated.csv | 24.1% | 23.7% | 27.3% | 24.1% | 22.7% |
| generated.json | 9.8% | 8.9% | 11.3% | 10.3% | 9.4% |
| github.pdf | 85.3% | 85.3% | 85.4% | 85.3% | 85.2% |
| ss.png | 97.2% | 97.2% | 97.2% | 97.2% | 97.2% |
| **All default files** | **23.3%** | **22.7%** | **25.2%** | **23.6%** | **22.6%** |

Pass your own files to compare those instead:

```sh
npm run bench -- path/to/file-or-folder
```

## How compression works

Each file is compressed on its own, in two stages:

1. **LZ77** scans backwards (up to 1 MB) for the longest earlier copy of the upcoming bytes, and replaces that repeat with a short "go back *distance* bytes and copy *length* bytes" instruction.
2. **Huffman coding** gives short bit codes to the bytes and instructions that occur often, and longer codes to rare ones. The file is split into blocks so the codes can change as the data changes.

A block that would not shrink is stored unchanged. A whole file that would not shrink is stored unchanged too, which is why a JPEG or a zip barely changes size.

Every stored file has a CRC-32 checksum. Extraction fails with an error if the bytes do not match, including when the archive is truncated or a bit has been flipped. Paths inside an archive cannot be absolute and cannot contain `..`, so extracting cannot write outside the folder you chose.

## Project layout

```
engine/            compression engine, no runtime dependencies
  src/index.ts     public API
  cli/             command-line tool
  test/            engine tests
  bench/           comparison with gzip
web/               browser app (Vite)
  src/             page, worker, and zip download helper
samples/           files used by the tests and the default benchmark
legacy-cpp/        original C++ program; not used, and not compatible with KP05
```

## Using the engine from code

`engine/src/index.ts` is the public API. This script works from the repository root on Node.js 22.18 or newer:

```ts
import { createArchive, extractArchive } from "./engine/src/index.ts";

const archive = createArchive(
  [
    { path: "notes/hello.txt", data: new TextEncoder().encode("hello") },
    { path: "notes", kind: "directory" },
  ],
  { level: "balanced", onProgress: (done, total) => console.log(done, total) },
);

for (const entry of extractArchive(archive)) {
  console.log(entry.path, entry.data.length);
}
```

Run it with `node script.ts`. Failures throw `KittyError`. The `code` is one of `CORRUPT`, `CHECKSUM`, `UNSUPPORTED`, `INVALID_INPUT`, or `TOO_LARGE`.

## Archive format (version 5)

All integers are little-endian. `varint` is an unsigned LEB128.

```
"KP05"   magic
u8       version (5)
u8       flags (0)
varint   entry count
entries:
  u8      kind (0 file, 1 folder)
  varint  path length, then the path as UTF-8 ("folder/file.txt")
  varint  modified time, seconds since 1970 (0 means unknown)
  files only:
    u8      method (0 stored, 1 KittyPress LZ)
    varint  original size
    varint  stored size
    u32     CRC-32 of the original bytes
    bytes   stored data
```

Compressed data is a sequence of blocks. Each block starts with 1 bit ("last block") and 2 bits (type). A stored block is raw bytes. A Huffman block carries its own code table, then literals, matches (lengths 3 to 1026, distances up to 1 MB), and an end-of-block code. The constants live in `engine/src/format.ts`, and the block layout is in `engine/src/codec.ts`.

## Limitations

- A file is held in memory while it is compressed, so a browser tab can run out of memory around a few hundred MB.
- Identical files inside one archive are compressed separately. Copies are not removed.
- On some very regular tables (certain CSV files), gzip -9 is still a few percent smaller.
- `KP01` through `KP04` archives are rejected with an "unsupported" error.
