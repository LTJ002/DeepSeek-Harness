'use strict';
// 对话与文件联动回滚：核心引擎单元测试
// 运行：runtime/node.exe --test plugins/dsh-desktop-settings/test/checkpoints.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCheckpointEngine, assertInside } = require('../lib/checkpoints.cjs');

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-test-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'two\n');
  return dir;
}
function gitWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-git-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'core.autocrlf', 'false']); // 让 checkout-index 按 blob 原样写回，避免 Windows 行尾干扰断言
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'two\n');
  run(['add', 'a.txt', 'sub/b.txt']);
  const commit = run(['commit', '-qm', 'init']);
  if (commit.status !== 0) throw new Error(`git init fixture 失败: ${commit.stderr}`);
  return dir;
}
function engineFor(root) {
  // 检查点存储目录放在工作区之外（与真实部署 ~/.dsh 一致）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewind-home-'));
  return createCheckpointEngine({ home: path.join(home, 'checkpoints') });
}

test('copy 快照：创建/差异/恢复/撤销，覆盖增删改', () => {
  const root = tmpWorkspace();
  const engine = engineFor(root);
  const cp = engine.createCheckpoint({ cwd: root, sessionId: 's1', messageId: 'm1', summary: '第一轮' });
  assert.equal(cp.provider, 'copy');

  // 修改 + 新增 + 删除
  fs.writeFileSync(path.join(root, 'a.txt'), 'one-modified\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  fs.rmSync(path.join(root, 'sub', 'b.txt'));

  const plan = engine.preview(cp.id);
  assert.ok(plan.total >= 3, `预期至少3个差异，实际 ${plan.total}`);
  const byPath = Object.fromEntries(plan.diffs.map((d) => [d.path, d.status]));
  assert.equal(byPath['a.txt'], 'modified');
  assert.equal(byPath['new.txt'], 'added');
  assert.equal(byPath['sub/b.txt'], 'deleted');

  const result = engine.execute(cp.id, plan.signature);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'two\n');

  // 撤销：恢复到回滚前（modified + new + deleted）
  const undo = engine.undoLatest(result.guard.id);
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one-modified\n');
  assert.ok(fs.existsSync(path.join(root, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'b.txt')));
});

test('git 快照：Git 仓库优先走对象快照，差异/恢复/撤销正确', { skip: (() => { try { spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }); return false; } catch { return 'git 不可用'; } })() }, () => {
  const root = gitWorkspace();
  const engine = engineFor(root);
  const cp = engine.createCheckpoint({ cwd: root, sessionId: 's-git', messageId: 'm-git', summary: 'git 轮' });
  assert.equal(cp.provider, 'git');
  assert.match(cp.ref, /^git:[0-9a-f]{40}$/);

  fs.writeFileSync(path.join(root, 'a.txt'), 'one-modified\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  fs.rmSync(path.join(root, 'sub', 'b.txt'));

  const plan = engine.preview(cp.id);
  assert.equal(plan.total, 3);
  const byPath = Object.fromEntries(plan.diffs.map((d) => [d.path, d.status]));
  assert.equal(byPath['a.txt'], 'modified');
  assert.equal(byPath['new.txt'], 'added');
  assert.equal(byPath['sub/b.txt'], 'deleted');

  const result = engine.execute(cp.id, plan.signature);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'two\n');

  const undo = engine.undoLatest(result.guard.id);
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one-modified\n');
  assert.ok(fs.existsSync(path.join(root, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'b.txt')));
});

test('陈旧计划检测：预览后工作区变化 → execute 拒绝', () => {
  const root = tmpWorkspace();
  const engine = engineFor(root);
  const cp = engine.createCheckpoint({ cwd: root, sessionId: 's2', messageId: 'm2' });
  const plan = engine.preview(cp.id);
  assert.ok(plan.total === 0);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed-after-preview\n');
  assert.throws(() => engine.execute(cp.id, plan.signature), (e) => e.code === 'REWIND_STALE');
  // 未恢复
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'changed-after-preview\n');
});

test('路径安全：拒绝 .. 穿越与指向外部的符号链接', { skip: process.platform === 'win32' && 'Windows 下创建符号链接需要特权，仅验证遍历' }, () => {
  const root = tmpWorkspace();
  assert.throws(() => assertInside(root, '../outside.txt'), (e) => e.code === 'REWIND_PATH');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'));
  const link = path.join(root, 'evil-link');
  fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => assertInside(root, 'evil-link'), (e) => e.code === 'REWIND_PATH');
  fs.rmSync(link, { force: true });
});
test('路径安全：拒绝 .. 穿越（Windows）', () => {
  const root = tmpWorkspace();
  assert.throws(() => assertInside(root, '../outside.txt'), (e) => e.code === 'REWIND_PATH');
  assert.throws(() => assertInside(root, 'sub/../../outside.txt'), (e) => e.code === 'REWIND_PATH');
});

test('保留策略：普通检查点最多保留上限，保护检查点独立计数', () => {
  const root = tmpWorkspace();
  const engine = createCheckpointEngine({ home: path.join(root, '.home'), keepRegular: 3, keepGuard: 2 });
  for (let i = 0; i < 6; i++) engine.createCheckpoint({ cwd: root, sessionId: 's3', messageId: `m${i}` });
  for (let i = 0; i < 4; i++) engine.createCheckpoint({ cwd: root, sessionId: 's3', type: 'guard', summary: `g${i}` });
  const regular = engine.list({ type: 'regular' });
  const guards = engine.list({ type: 'guard' });
  assert.equal(regular.length, 3);
  assert.equal(guards.length, 2);
});

test('ensureCheckpoint 幂等：同一消息只创建一个检查点', () => {
  const root = tmpWorkspace();
  const engine = engineFor(root);
  const a = engine.ensureCheckpoint({ cwd: root, sessionId: 's4', messageId: 'm-same' });
  const b = engine.ensureCheckpoint({ cwd: root, sessionId: 's4', messageId: 'm-same' });
  assert.equal(a.id, b.id);
  assert.equal(engine.list({ sessionId: 's4' }).length, 1);
});
