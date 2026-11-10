// CRC-32 (IEEE 802.3, same as ZIP/gzip/PNG), slicing-by-4 for speed.

const TABLES: Uint32Array[] = (() => {
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let t = 1; t < 4; t++) {
    const prev = tables[t - 1];
    const cur = new Uint32Array(256);
    for (let n = 0; n < 256; n++) cur[n] = (prev[n] >>> 8) ^ t0[prev[n] & 0xff];
    tables.push(cur);
  }
  return tables;
})();

/** Computes CRC-32 of `data`. Pass a previous result as `crc` to continue a running checksum. */
export function crc32(data: Uint8Array, crc = 0): number {
  const [t0, t1, t2, t3] = TABLES;
  let c = ~crc;
  let i = 0;
  const end4 = data.length & ~3;
  for (; i < end4; i += 4) {
    c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    c = t3[c & 0xff] ^ t2[(c >>> 8) & 0xff] ^ t1[(c >>> 16) & 0xff] ^ t0[c >>> 24];
  }
  for (; i < data.length; i++) c = t0[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
