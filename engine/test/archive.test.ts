import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createArchive, extractArchive, KittyError, listArchive, normalizeArchivePath } from "../src/index.ts";
import { equalBytes, randomBytes, rng, structuredMix, textLike } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function expectKittyError(fn: () => unknown, code?: string): void {
  assert.throws(fn, (err: unknown) => err instanceof KittyError && (code === undefined || err.code === code));
}

describe("archives", () => {
  it("round-trips files, folders, empty files and unicode names", () => {
    const modified = Date.UTC(2025, 0, 2, 3, 4, 5);
    const input = [
      { path: "docs", kind: "directory" as const },
      { path: "docs/readme.txt", data: textLike(50_000, 1), modified },
      { path: "docs/empty.txt", data: new Uint8Array(0) },
      { path: "docs/图片/猫 🐱.bin", data: randomBytes(70_000, 2) },
      { path: "empty-folder", kind: "directory" as const },
      { path: "data.bin", data: structuredMix(400_000, 3) },
    ];
    const archive = createArchive(input);
    const out = extractArchive(archive);
    assert.equal(out.length, input.length);
    for (let i = 0; i < input.length; i++) {
      assert.equal(out[i].path, input[i].path);
      assert.equal(out[i].kind, input[i].kind ?? "file");
      if (input[i].data) assert.ok(equalBytes(out[i].data, input[i].data!));
    }
    assert.equal(out[1].modified, modified);
    assert.deepEqual(
      listArchive(archive).map((e) => e.path),
      input.map((e) => e.path),
    );
  });

  it("normalizes separators and rejects unsafe paths", () => {
    assert.equal(normalizeArchivePath("a\\b/./c"), "a/b/c");
    assert.equal(normalizeArchivePath("/abs/file"), "abs/file");
    for (const bad of ["", "/", "../x", "a/../../x", "C:/windows", "a/b:c", "nul\0"]) {
      expectKittyError(() => normalizeArchivePath(bad), "INVALID_INPUT");
    }
  });

  it("rejects duplicate paths and file/folder clashes", () => {
    expectKittyError(() => createArchive([{ path: "a.txt", data: enc("1") }, { path: "./a.txt", data: enc("2") }]), "INVALID_INPUT");
    expectKittyError(() => createArchive([{ path: "a", data: enc("1") }, { path: "a/b", data: enc("2") }]), "INVALID_INPUT");
  });

  it("refuses archives with path traversal", () => {
    const archive = createArchive([{ path: "xx/evil.txt", data: enc("pwned") }]);
    const i = Buffer.from(archive).indexOf("xx/");
    archive.set(enc("../"), i);
    expectKittyError(() => extractArchive(archive), "CORRUPT");
  });

  it("detects old-format and non-kitty files", () => {
    expectKittyError(() => extractArchive(enc("KP04\x04\x00\x00\x00\x00")), "UNSUPPORTED");
    expectKittyError(() => extractArchive(enc("PK\x03\x04 a zip file")), "CORRUPT");
    expectKittyError(() => extractArchive(new Uint8Array(0)), "CORRUPT");
  });

  it("never returns wrong data from a damaged archive", () => {
    const files = [
      { path: "a.txt", data: textLike(60_000, 5) },
      { path: "b.bin", data: structuredMix(60_000, 6) },
      { path: "c.rnd", data: randomBytes(20_000, 7) },
    ];
    const archive = createArchive(files);
    const r = rng(77);
    let detected = 0;
    for (let trial = 0; trial < 600; trial++) {
      const bad = archive.slice();
      const pos = Math.floor(r() * bad.length);
      bad[pos] ^= 1 << Math.floor(r() * 8);
      const input = trial % 5 === 0 ? bad.subarray(0, pos) : bad;
      try {
        const out = extractArchive(input);
        // Only harmless fields (timestamps, reserved flags) may change without an error.
        for (let k = 0; k < files.length; k++) assert.ok(equalBytes(out[k].data, files[k].data));
      } catch (err) {
        assert.ok(err instanceof KittyError, `unexpected error type: ${err}`);
        detected++;
      }
    }
    assert.ok(detected > 550, `only ${detected} of 600 corruptions detected`);
  });

  it("round-trips the real sample files", () => {
    const dir = path.resolve(import.meta.dirname, "../../samples");
    const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
    const input = names.map((n) => ({ path: n, data: new Uint8Array(fs.readFileSync(path.join(dir, n))) }));
    const out = extractArchive(createArchive(input));
    for (let k = 0; k < input.length; k++) assert.ok(equalBytes(out[k].data, input[k].data), input[k].path);
  });
});
