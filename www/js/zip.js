/* Spark — minimal ZIP reader/writer, no dependencies.
   Writing uses the "store" method (no compression), so the result is a real
   .zip that any OS can open and whose audio files play straight from it.
   Reading handles stored entries directly and deflated entries through the
   browser's built-in DecompressionStream, so a re-zipped backup still imports. */
window.Zip = (function () {
  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const FLAG_UTF8 = 0x0800;

  /* ---------------- CRC-32 ---------------- */
  let TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }

  function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- helpers ---------------- */
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === 'string') return enc(v);
    throw new TypeError('zip: unsupported entry data');
  }

  function dosStamp(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /* ---------------- write ---------------- */
  // entries: [{ name: string, data: Uint8Array|string }] -> Uint8Array
  function write(entries, when) {
    const stamp = dosStamp(when ? new Date(when) : new Date());
    const body = [];
    const central = [];
    let offset = 0;

    entries.forEach((e) => {
      const nameBytes = enc(e.name);
      const data = toBytes(e.data);
      const crc = crc32(data);

      // local file header
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, FLAG_UTF8, true);
      lv.setUint16(8, 0, true);           // method 0 = store
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // compressed size
      lv.setUint32(22, data.length, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra length
      lh.set(nameBytes, 30);
      body.push(lh, data);

      // central directory record
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, FLAG_UTF8, true);
      cv.setUint16(10, 0, true);           // method
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comment
      cv.setUint16(34, 0, true);           // disk number
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lh.length + data.length;
    });

    const cdSize = central.reduce((n, c) => n + c.length, 0);

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);              // this disk
    ev.setUint16(6, 0, true);              // disk with central dir
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);        // central dir offset
    ev.setUint16(20, 0, true);             // comment length

    const parts = body.concat(central, [end]);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }

  /* ---------------- read ---------------- */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持解压，请用 Spark 导出的原始备份文件');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // -> [{ name, data: Uint8Array }]
  async function read(input) {
    const buf = toBytes(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // locate end-of-central-directory, scanning back over any trailing comment
    let eocd = -1;
    const floor = Math.max(0, buf.length - 66000);
    for (let i = buf.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这不是一个有效的 zip 文件');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];

    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('zip 目录已损坏');
      }
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec(buf.subarray(p + 46, p + 46 + nameLen));

      // sizes live in the local header too; skip its name/extra to find the data
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      let data = buf.subarray(start, start + compSize);

      if (method === 8) data = await inflateRaw(data);
      else if (method !== 0) throw new Error('不支持的压缩方式（method ' + method + '）');

      out.push({ name, data });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  return { write, read, crc32 };
})();
