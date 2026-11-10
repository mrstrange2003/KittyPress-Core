import { type Method, METHOD_KITTY_LZ, METHOD_STORED, compress, decompress } from "./codec.ts";
import { crc32 } from "./crc32.ts";
import { KittyError, corrupt } from "./errors.ts";
import { MAX_MATCH } from "./format.ts";
import type { Level } from "./lz77.ts";

// .kitty archive layout (all integers little-endian, "varint" = unsigned LEB128):
//
//   "KP05"  magic
//   u8      format version (5)
//   u8      flags (reserved, 0)
//   varint  entry count
//   entries, each:
//     u8      kind (0 = file, 1 = directory)
//     varint  path length, then UTF-8 path ("folder/sub/file.txt")
//     varint  modified time, seconds since 1970 (0 = unknown)
//     files only:
//       u8      method (0 = stored, 1 = KittyPress LZ)
//       varint  original size
//       varint  stored size
//       u32     CRC-32 of the original data
//       bytes   stored data

const MAGIC = [0x4b, 0x50, 0x30, 0x35]; // "KP05"
const FORMAT_VERSION = 5;
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

export type EntryKind = "file" | "directory";

export interface ArchiveInputEntry {
  /** Path inside the archive. Use "/" or "\" between folders. */
  path: string;
  kind?: EntryKind;
  /** File contents. Required for files, ignored for directories. */
  data?: Uint8Array;
  /** Last-modified time in milliseconds since 1970. */
  modified?: number;
}

export interface ArchiveEntryInfo {
  path: string;
  kind: EntryKind;
  originalSize: number;
  storedSize: number;
  method: Method;
  crc32: number;
  /** Milliseconds since 1970, or undefined if unknown. */
  modified?: number;
}

export interface ExtractedEntry extends ArchiveEntryInfo {
  /** File contents (empty for directories). */
  data: Uint8Array;
}

export interface CreateArchiveOptions {
  level?: Level;
  /** Progress over all file bytes; `path` is the file currently being compressed. */
  onProgress?: (doneBytes: number, totalBytes: number, path: string) => void;
}

export interface ExtractArchiveOptions {
  onProgress?: (doneEntries: number, totalEntries: number, path: string) => void;
}

/**
 * Cleans up a path for storage in an archive: "/" separators, no empty or "." parts.
 * Rejects ".." and characters that could escape the extraction folder or break on Windows.
 */
export function normalizeArchivePath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new KittyError("INVALID_INPUT", `Invalid path "${path}"`);
  for (const part of parts) {
    if (part === "..") throw new KittyError("INVALID_INPUT", `Path "${path}" must not contain ".."`);
    if (/[\x00-\x1f:*?"<>|]/.test(part)) {
      throw new KittyError("INVALID_INPUT", `Path "${path}" contains characters not allowed in file names`);
    }
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------------------
// Writing

class ByteSink {
  readonly parts: Uint8Array[] = [];
  private scratch: number[] = [];

  byte(v: number): void {
    this.scratch.push(v & 0xff);
  }

  bytes(b: Uint8Array): void {
    this.flushScratch();
    this.parts.push(b);
  }

  u32(v: number): void {
    this.byte(v);
    this.byte(v >>> 8);
    this.byte(v >>> 16);
    this.byte(v >>> 24);
  }

  varint(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid varint ${v}`);
    while (v >= 0x80) {
      this.byte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.byte(v);
  }

  private flushScratch(): void {
    if (this.scratch.length) {
      this.parts.push(Uint8Array.from(this.scratch));
      this.scratch = [];
    }
  }

  finish(): Uint8Array {
    this.flushScratch();
    let total = 0;
    for (const p of this.parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

const utf8Encoder = new TextEncoder();

/** Packs files and folders into a single .kitty archive. */
export function createArchive(entries: ArchiveInputEntry[], options: CreateArchiveOptions = {}): Uint8Array {
  const prepared = entries.map((e) => {
    const kind: EntryKind = e.kind ?? "file";
    const path = normalizeArchivePath(e.path);
    if (kind === "file" && !e.data) throw new KittyError("INVALID_INPUT", `File "${path}" has no data`);
    return { ...e, kind, path };
  });

  const seen = new Map<string, EntryKind>();
  for (const e of prepared) {
    if (seen.has(e.path)) throw new KittyError("INVALID_INPUT", `Duplicate path "${e.path}" in archive`);
    seen.set(e.path, e.kind);
  }
  for (const e of prepared) {
    const parts = e.path.split("/");
    for (let k = 1; k < parts.length; k++) {
      const parent = parts.slice(0, k).join("/");
      if (seen.get(parent) === "file") {
        throw new KittyError("INVALID_INPUT", `"${parent}" is a file but "${e.path}" uses it as a folder`);
      }
    }
  }

  const totalBytes = prepared.reduce((sum, e) => sum + (e.kind === "file" ? e.data!.length : 0), 0);
  let doneBytes = 0;

  const sink = new ByteSink();
  for (const b of MAGIC) sink.byte(b);
  sink.byte(FORMAT_VERSION);
  sink.byte(0);
  sink.varint(prepared.length);

  for (const e of prepared) {
    const pathBytes = utf8Encoder.encode(e.path);
    sink.byte(e.kind === "file" ? KIND_FILE : KIND_DIRECTORY);
    sink.varint(pathBytes.length);
    sink.bytes(pathBytes);
    sink.varint(e.modified && e.modified > 0 ? Math.floor(e.modified / 1000) : 0);
    if (e.kind === "directory") continue;

    const data = e.data!;
    const base = doneBytes;
    const packed = compress(data, {
      level: options.level,
      onProgress: (done) => options.onProgress?.(base + done, totalBytes, e.path),
    });
    doneBytes += data.length;
    options.onProgress?.(doneBytes, totalBytes, e.path);

    sink.byte(packed.method);
    sink.varint(data.length);
    sink.varint(packed.data.length);
    sink.u32(crc32(data));
    sink.bytes(packed.data);
  }
  return sink.finish();
}

// ---------------------------------------------------------------------------------------
// Reading

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class ByteSource {
  private readonly buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw corrupt("Archive ends unexpectedly");
    return this.buf[this.pos++];
  }

  bytes(n: number): Uint8Array {
    if (n > this.remaining) throw corrupt("Archive ends unexpectedly");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u32(): number {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (!Number.isSafeInteger(result)) throw corrupt("Number in archive header is too large");
      if (!(b & 0x80)) return result;
      scale *= 0x80;
    }
  }
}

interface RawEntry extends ArchiveEntryInfo {
  stored: Uint8Array;
}

function readEntries(archive: Uint8Array): RawEntry[] {
  if (!isKittyArchive(archive)) {
    if (archive.length >= 4 && archive[0] === 0x4b && archive[1] === 0x50 && archive[2] === 0x30) {
      throw new KittyError(
        "UNSUPPORTED",
        `This archive was made by an older KittyPress (format KP0${String.fromCharCode(archive[3])}), which is not supported`,
      );
    }
    throw corrupt("Not a KittyPress archive");
  }
  const src = new ByteSource(archive);
  src.bytes(MAGIC.length);
  const version = src.byte();
  if (version !== FORMAT_VERSION) throw new KittyError("UNSUPPORTED", `Unsupported archive version ${version}`);
  src.byte();
  const count = src.varint();
  // Every entry takes at least 3 bytes, which bounds the count for damaged headers.
  if (count > src.remaining / 3) throw corrupt("Archive entry count is invalid");

  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const kindByte = src.byte();
    if (kindByte !== KIND_FILE && kindByte !== KIND_DIRECTORY) throw corrupt("Unknown entry type");
    const pathLen = src.varint();
    let path: string;
    try {
      path = utf8Decoder.decode(src.bytes(pathLen));
    } catch (err) {
      if (err instanceof KittyError) throw err;
      throw corrupt("Entry name is not valid text");
    }
    let safe: string;
    try {
      safe = normalizeArchivePath(path);
    } catch {
      throw corrupt(`Archive contains an unsafe path "${path}"`);
    }
    if (safe !== path) throw corrupt(`Archive contains an unsafe path "${path}"`);
    if (seen.has(path)) throw corrupt(`Archive contains "${path}" twice`);
    seen.add(path);

    const mtime = src.varint();
    const modified = mtime > 0 ? mtime * 1000 : undefined;
    if (kindByte === KIND_DIRECTORY) {
      entries.push({
        path,
        kind: "directory",
        originalSize: 0,
        storedSize: 0,
        method: METHOD_STORED,
        crc32: 0,
        modified,
        stored: new Uint8Array(0),
      });
      continue;
    }

    const method = src.byte();
    if (method !== METHOD_STORED && method !== METHOD_KITTY_LZ) throw corrupt(`Unknown compression method ${method}`);
    const originalSize = src.varint();
    const storedSize = src.varint();
    const checksum = src.u32();
    const stored = src.bytes(storedSize);
    entries.push({ path, kind: "file", originalSize, storedSize, method, crc32: checksum, modified, stored });
  }
  if (src.remaining !== 0) throw corrupt("Unexpected data after the last archive entry");
  return entries;
}

/** True if the bytes start like a current-format .kitty archive. */
export function isKittyArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

/** Lists what's in an archive without decompressing anything. */
export function listArchive(archive: Uint8Array): ArchiveEntryInfo[] {
  return readEntries(archive).map(({ stored: _stored, ...info }) => info);
}

/** Decompresses every entry and verifies its checksum. */
export function extractArchive(archive: Uint8Array, options: ExtractArchiveOptions = {}): ExtractedEntry[] {
  const raw = readEntries(archive);
  const result: ExtractedEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const { stored, ...info } = raw[i];
    let data = stored;
    if (info.kind === "file") {
      // A single compressed bit can expand to at most MAX_MATCH / 2 bytes.
      if (info.method === METHOD_KITTY_LZ && info.originalSize > info.storedSize * 4 * MAX_MATCH + 64) {
        throw corrupt(`"${info.path}" claims an impossible size`);
      }
      try {
        data = decompress(info.method, stored, info.originalSize);
      } catch (err) {
        if (err instanceof RangeError) {
          throw new KittyError("TOO_LARGE", `"${info.path}" is too large to decompress in memory`);
        }
        if (err instanceof KittyError && err.code === "CORRUPT") {
          throw corrupt(`"${info.path}" is damaged: ${err.message}`);
        }
        throw err;
      }
      if (crc32(data) !== info.crc32) {
        throw new KittyError("CHECKSUM", `"${info.path}" is damaged: checksum does not match`);
      }
    }
    result.push({ ...info, data });
    options.onProgress?.(i + 1, raw.length, info.path);
  }
  return result;
}
