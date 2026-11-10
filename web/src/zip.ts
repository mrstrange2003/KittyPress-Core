import { crc32 } from "../../engine/src/crc32.ts";

export interface ZipItem {
  /** Forward-slash path. Directories may omit the trailing slash. */
  path: string;
  /** File bytes. Leave out for a directory entry. */
  data?: Uint8Array;
  modified?: number;
}

/**
 * Builds a ZIP of already-extracted files so a browser can download a folder.
 * Files are stored uncompressed: KittyPress already did the compression, and the
 * zip is only a way to hand several files to the browser at once.
 */
export function buildZip(items: ZipItem[]): Uint8Array {
  if (items.length > 0xffff) {
    throw new Error("Too many files for one zip. Save to a folder instead.");
  }
  const bin = new BinWriter();
  const central: Central[] = [];
  const encoded = new TextEncoder();

  for (const item of items) {
    const directory = item.data === undefined;
    const name = item.path.replace(/^\/+/, "").replace(/\\/g, "/");
    if (name === "" || name.split("/").includes("..")) throw new Error(`Unsafe zip path "${item.path}"`);
    const path = encoded.encode(directory ? name.replace(/\/?$/, "/") : name);
    const data = item.data ?? new Uint8Array(0);
    if (data.length > 0xffffffff) throw new Error(`${item.path} is too large for a zip download`);
    const checksum = directory ? 0 : crc32(data);
    const [time, date] = dosDateTime(item.modified ?? Date.now());
    const offset = bin.length;
    if (offset > 0xffffffff) throw new Error("The zip would be too large to download");

    bin.u32(0x04034b50);
    bin.u16(20);
    bin.u16(0x0800);
    bin.u16(0);
    bin.u16(time);
    bin.u16(date);
    bin.u32(checksum);
    bin.u32(data.length);
    bin.u32(data.length);
    bin.u16(path.length);
    bin.u16(0);
    bin.bytes(path);
    if (!directory && data.length) bin.bytes(data);
    central.push({ path, checksum, size: data.length, offset, directory, time, date });
  }

  const centralStart = bin.length;
  for (const entry of central) {
    bin.u32(0x02014b50);
    bin.u16(20);
    bin.u16(20);
    bin.u16(0x0800);
    bin.u16(0);
    bin.u16(entry.time);
    bin.u16(entry.date);
    bin.u32(entry.checksum);
    bin.u32(entry.size);
    bin.u32(entry.size);
    bin.u16(entry.path.length);
    bin.u16(0);
    bin.u16(0);
    bin.u16(0);
    bin.u16(0);
    bin.u32(entry.directory ? 0x10 : 0);
    bin.u32(entry.offset);
    bin.bytes(entry.path);
  }
  const centralEnd = bin.length;
  bin.u32(0x06054b50);
  bin.u16(0);
  bin.u16(0);
  bin.u16(central.length);
  bin.u16(central.length);
  bin.u32(centralEnd - centralStart);
  bin.u32(centralStart);
  bin.u16(0);
  return bin.finish();
}

interface Central {
  path: Uint8Array;
  checksum: number;
  size: number;
  offset: number;
  directory: boolean;
  time: number;
  date: number;
}

function dosDateTime(ms: number): [number, number] {
  const date = new Date(ms);
  const year = date.getFullYear();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(year, 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

/** Small binary writer that keeps large payloads as their own chunks instead of copying them. */
class BinWriter {
  private readonly parts: Uint8Array[] = [];
  private scratch = new Uint8Array(64);
  private view = new DataView(this.scratch.buffer);
  private used = 0;
  length = 0;

  private flush(): void {
    if (this.used === 0) return;
    this.parts.push(this.scratch.slice(0, this.used));
    this.used = 0;
  }

  private room(n: number): void {
    if (this.used + n <= this.scratch.length) return;
    this.flush();
    if (n > this.scratch.length) {
      this.scratch = new Uint8Array(n);
      this.view = new DataView(this.scratch.buffer);
    }
  }

  u16(value: number): void {
    this.room(2);
    this.view.setUint16(this.used, value, true);
    this.used += 2;
    this.length += 2;
  }

  u32(value: number): void {
    this.room(4);
    this.view.setUint32(this.used, value, true);
    this.used += 4;
    this.length += 4;
  }

  bytes(data: Uint8Array): void {
    this.flush();
    this.parts.push(data);
    this.length += data.length;
  }

  finish(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
