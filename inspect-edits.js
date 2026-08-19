// 检查最后一轮对话中的编辑类工具调用，判断能回滚哪些文件修改
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
// 找最后一次用户 spliced
let idx = -1;
for (let i = lines.length - 1; i >= 1; i--) {
  let p; try { p = JSON.parse(lines[i]); } catch { continue; }
  if (p?.type === 'agent/inbox/spliced' && p.data?.inserted?.length) { idx = i; break; }
}
console.log('last user message line:', idx, 'total lines:', lines.length);
let lastCall = null;
let printed = 0;
for (let i = 1; i < lines.length; i++) {
  let p; try { p = JSON.parse(lines[i]); } catch { continue; }
  if (p?.type === 'tool/call') {
    lastCall = p;
    const n = p.data?.name || '';
    if (/write|edit|str_replace/i.test(n) && printed < 6) {
      printed++;
      console.log(`\ntool/call @${i} name=${n}`);
      console.log('  args:', (p.data?.arguments || '').slice(0, 500));
    }
  } else if (p?.type === 'tool/result' && lastCall && /write|edit|str_replace/i.test(lastCall.data?.name || '') && printed > 0) {
    const content = JSON.stringify(p.data?.message ?? {}).slice(0, 600);
    console.log(`tool/result @${i}:`, content);
  }
}
