import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32 } from "../../engine/src/crc32.ts";
import { buildZip } from "../src/zip.ts";

/** Reads a stored (uncompressed) zip and checks each file's CRC-32. */
function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const rawSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const data = bytes.subarray(nameStart + nameLength + extraLength, nameStart + nameLength + extraLength + size);
    assert.equal(flags & 0x0800, 0x0800, `${name} should be marked UTF-8`);
    assert.equal(method, 0, `${name} should be stored, not recompressed`);
    assert.equal(size, rawSize, name);
    if (name.endsWith("/")) assert.equal(size, 0, name);
    else assert.equal(crc32(data), checksum, `${name} checksum`);
    out.set(name, data);
    offset = nameStart + nameLength + extraLength + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "zip is missing its central directory");
  return out;
}

describe("buildZip", () => {
  it("stores files, empty files, folders, and unicode names", () => {
    const hello = new TextEncoder().encode("hello café");
    const zip = buildZip([
      { path: "notes/café.txt", data: hello },
      { path: "notes/empty", data: new Uint8Array() },
      { path: "empty-dir" },
    ]);
    const files = readStoredZip(zip);
    assert.deepEqual(files.get("notes/café.txt"), hello);
    assert.equal(files.get("notes/empty")?.length, 0);
    assert.ok(files.has("empty-dir/"));
  });

  it("rejects paths that could escape the folder", () => {
    assert.throws(() => buildZip([{ path: "../secret.txt", data: new Uint8Array([1]) }]));
  });
});
