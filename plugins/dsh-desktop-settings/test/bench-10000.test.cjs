'use strict';
// 10,000 文件性能基准：文件复制快照的 创建 → 差异预览 → 回滚 全链路。
// 阈值按宽松的“防退化”目标设置（Windows Defender/杀软会让磁盘操作慢数倍）：
// 只保证功能正确，并把实测耗时打印出来供记录。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCheckpointEngine } = require('../lib/checkpoints.cjs');

const FILES = 10000;
const DIRS = 10;

test('10,000 文件性能基准：创建/预览/回滚正确且可接受', { timeout: 600000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-bench-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-bench-root-'));
  try {
    // 10 个目录 × 1000 个文件
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `dir-${String(d).padStart(2, '0')}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < FILES / DIRS; i++) {
        fs.writeFileSync(path.join(dir, `file-${i}.txt`), `original ${d} ${i}\n`);
      }
    }
    const engine = createCheckpointEngine({ home });

    let t0 = Date.now();
    const cp = engine.createCheckpoint({ cwd: root, sessionId: 'bench', messageId: 'bench-m1', summary: '10k 基准' });
    const createMs = Date.now() - t0;

    // 修改 2000 个 / 新建 500 个 / 删除 500 个
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `dir-${String(d).padStart(2, '0')}`);
      for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), `changed ${d} ${i}\n`);
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `new-${i}.txt`), `new ${i}\n`);
      for (let i = 0; i < 50; i++) fs.rmSync(path.join(dir, `file-${900 + i}.txt`), { force: true });
    }

    t0 = Date.now();
    const plan = engine.preview(cp.id);
    const previewMs = Date.now() - t0;
    assert.equal(plan.total, DIRS * (200 + 50 + 50), '差异文件数应等于 2000 修改 + 500 新建 + 500 删除');
    assert.equal(plan.diffs.filter((d) => d.status === 'modified').length, DIRS * 200);
    assert.equal(plan.diffs.filter((d) => d.status === 'added').length, DIRS * 50);
    assert.equal(plan.diffs.filter((d) => d.status === 'deleted').length, DIRS * 50);

    t0 = Date.now();
    const result = engine.execute(cp.id, plan.signature);
    const executeMs = Date.now() - t0;
    assert.ok(result.ok);
    assert.equal(result.guard.type, 'guard');

    // 正确性抽查
    assert.equal(fs.readFileSync(path.join(root, 'dir-00', 'file-0.txt'), 'utf8'), 'original 0 0\n');
    assert.equal(fs.existsSync(path.join(root, 'dir-00', 'new-0.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'dir-00', 'file-950.txt')), true);

    // 防退化阈值（宽松）
    assert.ok(createMs < 180000, `创建过快照超时: ${createMs}ms`);
    assert.ok(previewMs < 180000, `差异预览超时: ${previewMs}ms`);
    assert.ok(executeMs < 180000, `回滚执行超时: ${executeMs}ms`);

    console.log(`[bench-10000] create=${createMs}ms preview=${previewMs}ms execute=${executeMs}ms total=${createMs + previewMs + executeMs}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
