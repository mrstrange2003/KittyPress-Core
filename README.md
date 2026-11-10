# KittyPress

KittyPress is a lossless file compressor with its own archive format (`.kitty`). It packs
files and folders into one archive and unpacks them byte-for-byte identical.

The engine is written in TypeScript so the same code runs in **web browsers** (for the
upcoming web app) and in **Node.js** (for the command-line tool and tests).

## Quick start

Requires Node.js 22.18 or newer. From the repository root:

```powershell
npm install

# compress files and/or folders into an archive
npm run kp -- compress photos notes.txt backup.kitty
npm run kp -- compress big-folder out.kitty --level max

# see what's inside
npm run kp -- list backup.kitty

# extract (refuses to overwrite existing files unless you add --force)
npm run kp -- decompress backup.kitty restored-folder
```

Levels: `fast` (quickest), `balanced` (default), `max` (smallest output, slower).

## How well does it compress?

Measured on 17 real files (116 MB total: source code, CSV, Windows programs and DLLs,
fonts, WAV audio, PDF, PNG, JPEG, ZIP-based `.whl`). Numbers are compressed size as a
percentage of the original, so lower is better. gzip is the algorithm inside `.zip` and `.gz` files.

| | gzip -6 | gzip -9 | KittyPress fast | KittyPress balanced | KittyPress max |
|---|---|---|---|---|---|
| All files | 40.3% | 40.2% | 39.6% | 37.1% | 35.6% |
| TypeScript source (8.9 MB) | 18.0% | 18.0% | 18.7% | 16.5% | 15.2% |
| node.exe (83 MB) | 39.5% | 39.4% | 38.4% | 35.8% | 34.0% |

Typical speed on this machine: compression 15-40 MB/s (balanced), decompression 100-300 MB/s.
Already-compressed files (JPEG, PNG, MP4, ZIP...) are detected and stored as-is instead of
wasting time on them. Run the comparison yourself with `npm run bench`.

## How it works (plain-language version)

Compression happens in two stages, the same basic idea as ZIP but tuned differently:

1. **LZ77: find repeats.** The compressor walks through the file and, at each position, looks
   back (up to 1 MB) for the longest earlier copy of the upcoming bytes. Repeats are replaced
   by a short "go back *distance* bytes and copy *length* bytes" instruction. Hash tables make
   the search fast, and "lazy matching" checks whether waiting one byte gives a better repeat.
2. **Huffman coding: shorter codes for common things.** The literal bytes and copy instructions
   are counted, and frequent ones get short bit codes while rare ones get longer codes. The
   data is split into blocks so the codes can adapt as the file changes (text, then images, etc.).

Safety features:

- Every file stores a **CRC-32 checksum**. Any damage is detected on extraction instead of
  silently producing a broken file.
- Blocks that don't shrink are **stored raw**, so incompressible data grows by only a few bytes.
- Archive paths are validated, so a malicious archive can't write outside the target folder
  (no `../` tricks).
- Damaged or truncated archives produce a clear error, never a crash or hang (fuzz-tested).

## Project layout

```
engine/            the compression engine (TypeScript, no runtime dependencies)
  src/index.ts     public API used by the CLI and (later) the web app
  src/lz77.ts      repeat finder (LZ77 match finder)
  src/huffman.ts   Huffman code construction and decoding
  src/codec.ts     turns tokens into compressed blocks and back
  src/archive.ts   the .kitty container (multiple files, folders, checksums)
  cli/             command-line tool
  test/            automated tests (npm test)
  bench/           benchmark against gzip (npm run bench)
legacy-cpp/        the original C++ version (kept for reference; its format is not supported)
samples/           sample files used by tests
```

## Using the engine from code

```ts
import { createArchive, extractArchive, listArchive } from "@kittypress/engine";

const archive = createArchive(
  [
    { path: "notes/hello.txt", data: new TextEncoder().encode("hello") },
    { path: "notes/empty-folder", kind: "directory" },
  ],
  { level: "balanced", onProgress: (done, total) => console.log(done / total) },
);

for (const entry of extractArchive(archive)) console.log(entry.path, entry.data.length);
```

Errors are thrown as `KittyError` with a `code` of `CORRUPT`, `CHECKSUM`, `UNSUPPORTED`,
`INVALID_INPUT` or `TOO_LARGE`, so an app can show a friendly message.

## The .kitty format (version 5)

All integers are little-endian; "varint" is unsigned LEB128.

```
"KP05" magic, u8 version (5), u8 flags (0), varint entry count
per entry: u8 kind (0 file, 1 folder), varint path length, UTF-8 path, varint modified time (s)
  files also: u8 method (0 stored, 1 KittyPress LZ), varint original size,
              varint stored size, u32 CRC-32, stored bytes
```

Compressed data is a sequence of blocks (1 bit "last block", 2 bits type). Stored blocks hold
raw bytes; Huffman blocks carry their own code tables (DEFLATE-style run-length coded) followed
by literals, matches (40 length codes for lengths 3-1026, 40 distance codes for up to 1 MB)
and an end-of-block code. See `engine/src/format.ts` and `engine/src/codec.ts` for details.

## Known limitations

- Whole files are held in memory while compressing, which caps practical file size in a
  browser at roughly a few hundred MB.
- Each file is compressed separately, so identical files inside one archive are not deduplicated.
- On some very regular tabular data (e.g. certain CSVs) gzip -9 is still ~2-4% smaller.
- Archives made by the old C++ KittyPress (KP01-KP04) can't be opened; they are reported as unsupported.
