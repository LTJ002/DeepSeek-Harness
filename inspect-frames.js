const fs = require('fs');
const zlib = require('zlib');
const file = process.argv[2];
const b = fs.readFileSync(file);
const MAGIC = 4247762216;
const frames = [];
let o = 0;
while (o < b.length) {
  const start = o;
  if (b.readUInt32LE(o) !== MAGIC) throw new Error('magic');
  o += 4;
  const d = b.readUInt8(o++);
  const csf = d >>> 6; const ss = (d & 32) !== 0; const ck = (d & 4) !== 0;
  const db = d & 3; const dbs = db === 3 ? 4 : db;
  const cbs = csf === 0 ? (ss ? 1 : 0) : (1 << csf);
  o += (ss ? 0 : 1) + dbs + cbs;
  for (;;) {
    const h = b.readUIntLE(o, 3); o += 3;
    const last = (h & 1) !== 0; const bt = (h >>> 1) & 3; const sz = h >>> 3;
    if (bt === 3) throw new Error('res');
    o += bt === 1 ? 1 : sz;
    if (last) break;
  }
  if (ck) o += 4;
  frames.push({ start, end: o });
}
console.log('frames:', frames.length, 'file:', b.length);
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  let text;
  try { text = zlib.zstdDecompressSync(b.subarray(f.start, f.end)).toString('utf8'); }
  catch (e) { console.log(`frame ${i} [${f.start},${f.end}] DECOMPRESS ERROR: ${e.message}`); continue; }
  const endsNewline = text.endsWith('\n');
  const lastLine = text.split('\n').at(-1) ?? '';
  let parse = 'ok';
  try { if (lastLine.trim()) JSON.parse(lastLine); else parse = 'empty-tail'; } catch (e) { parse = 'torn: ' + e.message; }
  console.log(`frame ${i} [${f.start},${f.end}] bytes=${text.length} endsNL=${endsNewline} tailLen=${lastLine.length} tail=${JSON.stringify(lastLine.slice(-60))} parse=${parse}`);
  if (i > 30) { console.log('... more frames'); break; }
}
