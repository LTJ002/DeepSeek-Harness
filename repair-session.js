// 诊断/修复损坏的 session.jsonl.zstd（seq 断层 + sourceEventSeqs 引用错误）
// 用法：
//   node repair-session.js <file>          仅检查
//   node repair-session.js <file> repair   检查并修复
const fs = require('fs');
const zlib = require('zlib');

const ZSTD_MAGIC = 4247762216;
const CHUNK_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) throw new Error('torn frame');
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`);
    offset += 4;
    const descriptor = buf.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}
function decompressAll(buf) {
  const frames = scanZstdFrames(buf);
  const parts = frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)));
  return Buffer.concat(parts);
}
function chunkCount(node) {
  if (!node || typeof node !== 'object' || !CHUNK_TYPES.has(node.type)) return 0;
  const members = node.type === 'tool-call-chunks' ? node.data?.args : node.data?.texts;
  return Array.isArray(members) ? members.length : 0;
}
function collectSeqs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) collectSeqs(x, out); return out; }
  if (typeof node.seq === 'number') out.push(node.seq);
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectSeqs(v, out);
  return out;
}
function rowSeqs(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (CHUNK_TYPES.has(parsed.type)) {
    const n = chunkCount(parsed);
    if (typeof parsed.seq0 === 'number') return Array.from({ length: n }, (_, k) => parsed.seq0 + k);
    return [];
  }
  return collectSeqs(parsed);
}
// 收集一行里所有 seq/seq0 数字（含 chunk 展开的每个 seq），供 old→new 映射使用
function collectSeqNumbers(node, out, seen) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) collectSeqNumbers(x, out, seen); return out; }
  const push = (v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } };
  if (typeof node.seq === 'number') push(node.seq);
  if (CHUNK_TYPES.has(node.type) && typeof node.seq0 === 'number') {
    const n = chunkCount(node);
    for (let k = 0; k < n; k++) push(node.seq0 + k);
  } else if (typeof node.seq0 === 'number') {
    push(node.seq0);
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectSeqNumbers(v, out, seen);
  return out;
}
function remapSeqs(node, map) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) { for (const x of node) remapSeqs(x, map); return node; }
  if (typeof node.seq === 'number' && map.has(node.seq)) node.seq = map.get(node.seq);
  if (typeof node.seq0 === 'number' && map.has(node.seq0)) node.seq0 = map.get(node.seq0);
  if (Array.isArray(node.sourceEventSeqs)) {
    node.sourceEventSeqs = node.sourceEventSeqs.map((r) => (Number.isSafeInteger(r) && map.has(r) ? map.get(r) : r));
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') remapSeqs(v, map);
  return node;
}
function refProblem(parsed) {
  const raw = parsed?.sourceEventSeqs;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'sourceEventSeqs 不是数组';
  if (raw.length === 0 && parsed.type !== 'assistant/message') return 'sourceEventSeqs 为空';
  const set = new Set();
  for (const r of raw) {
    if (!Number.isSafeInteger(r) || r < 0) return `sourceEventSeqs 含非法值 ${r}`;
    if (set.has(r)) return `sourceEventSeqs 重复 ${r}`;
    set.add(r);
  }
  const own = typeof parsed.seq === 'number' ? parsed.seq : (typeof parsed.seq0 === 'number' ? parsed.seq0 : null);
  if (own !== null) {
    const bad = raw.find((r) => r >= own);
    if (bad !== undefined) return `sourceEventSeqs ${bad} >= 当前 seq ${own}`;
  }
  return null;
}
function sanitizeRefs(parsed, dropped) {
  const raw = parsed?.sourceEventSeqs;
  if (!Array.isArray(raw)) return;
  const own = typeof parsed.seq === 'number' ? parsed.seq : (typeof parsed.seq0 === 'number' ? parsed.seq0 : null);
  const clean = [];
  for (const r of raw) {
    if (!Number.isSafeInteger(r) || r < 0) { dropped.push(`非法 ${r}`); continue; }
    if (own !== null && r >= own) { dropped.push(`越界 ${r}>=${own}`); continue; }
    if (clean.includes(r)) { dropped.push(`重复 ${r}`); continue; }
    clean.push(r);
  }
  if (clean.length === 0 && parsed.type !== 'assistant/message' && own !== null && own > 0) clean.push(own - 1);
  parsed.sourceEventSeqs = clean;
}
function verify(lines) {
  let expected = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let p;
    try { p = JSON.parse(lines[i]); } catch (e) { return `line ${i} 无法解析`; }
    const s = rowSeqs(p);
    if (s.length && s[0] !== expected) return `line ${i}: seq 不连续（期望 ${expected}，实际 ${s[0]}）`;
    if (s.length) expected = s[s.length - 1] + 1;
    const rp = refProblem(p);
    if (rp) return `line ${i}: ${rp}`;
  }
  return null;
}

const file = process.argv[2];
const repair = process.argv[3] === 'repair';
if (!file) { console.log('usage: node repair-session.js <session.jsonl.zstd> [repair]'); process.exit(2); }

const buf = fs.readFileSync(file);
const plain = decompressAll(buf);
const text = plain.toString('utf8');
const lines = text.split('\n');
console.log(`frames ok, plaintext ${plain.length} bytes, ${lines.length} lines`);

const problem = verify(lines);
if (!problem) { console.log('OK: seq 连续且 sourceEventSeqs 全部合法'); process.exit(0); }
console.log('PROBLEM:', problem);

if (!repair) process.exit(1);

// ---- 修复：把所有 seq/seq0 按行序重排成 0..N-1，同时映射 sourceEventSeqs ----
const rows = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  let p;
  try { p = JSON.parse(lines[i]); } catch (e) { console.log(`line ${i} 无法解析，中止`); process.exit(1); }
  rows.push({ i, p });
}
const map = new Map();
const seen = new Set();
let next = 0;
for (const { p } of rows) {
  for (const v of collectSeqNumbers(p, [], seen)) {
    if (!map.has(v)) map.set(v, next++);
  }
}
const dropped = [];
for (const { p } of rows) {
  remapSeqs(p, map);
  sanitizeRefs(p, dropped);
}
const header = lines[0] || '';
const body = rows.map((r) => JSON.stringify(r.p)).join('\n');
const fixed = header + '\n' + body + '\n';
const checkLines = fixed.split('\n');
const after = verify(checkLines);
if (after) { console.log('修复后校验失败：', after); process.exit(1); }

const headerEnd = fixed.indexOf('\n');
const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const out = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(fixed.slice(0, headerEnd + 1), 'utf8'), opts),
  zlib.zstdCompressSync(Buffer.from(fixed.slice(headerEnd + 1), 'utf8'), opts)
]);
const backup = file + '.bak-' + Date.now();
fs.copyFileSync(file, backup);
fs.writeFileSync(file, out);
console.log('REPAIRED → backup:', backup, '→ new size:', out.length, '→ dropped refs:', dropped.length);
console.log('verify OK, total events =', rows.length);
