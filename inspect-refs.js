// 检查 seed/sourceEventSeqs 引用，定位修复后仍不通过校验的原因
const fs = require('fs');
const zlib = require('zlib');
const ZSTD_MAGIC = 4247762216;
function scanFrames(buf) {
  const frames = []; let off = 0;
  while (off < buf.length) {
    const start = off;
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('magic');
    off += 4;
    const d = buf.readUInt8(off++);
    const csf = d >>> 6, single = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    off += (single ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (single ? 1 : 0) : (1 << csf));
    for (;;) {
      const bh = buf.readUIntLE(off, 3); off += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      off += bt === 1 ? 1 : bs;
      if (last) break;
    }
    if (ck) off += 4;
    frames.push({ start, end: off });
  }
  return frames;
}
const file = process.argv[2];
const buf = fs.readFileSync(file);
const plain = Buffer.concat(scanFrames(buf).map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end))));
const lines = plain.toString('utf8').split('\n');
console.log('lines:', lines.length);
let shown = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line || !line.includes('sourceEventSeqs')) continue;
  let p; try { p = JSON.parse(line); } catch { continue; }
  console.log(`line ${i}: type=${p.type} seq=${p.seq} refs=${JSON.stringify(p.data?.sourceEventSeqs ?? p.sourceEventSeqs)}`);
  if (++shown >= 15) break;
}
// 打印 seq 292752 附近
for (let i = 1; i < lines.length; i++) {
  const line = lines[i]; if (!line) continue;
  let p; try { p = JSON.parse(line); } catch { continue; }
  if (p.seq === 292752 || (p.seq0 !== undefined && p.seq0 <= 292752 && p.seq0 + 20 >= 292752)) {
    console.log(`near ${i}:`, line.slice(0, 300));
  }
}
