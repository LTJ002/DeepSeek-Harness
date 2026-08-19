'use strict';
// /rewind 命令参数解析单测（宿主模块为 ESM，动态导入）
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href;

test('/rewind 参数解析：list / preview / step / guard / 直接回滚', async () => {
  const mod = await import(MODULE_URL);
  assert.deepStrictEqual(mod.parseRewindInput(''), { verb: 'list', arg: '' });
  assert.deepStrictEqual(mod.parseRewindInput('list'), { verb: 'list', arg: '' });
  assert.deepStrictEqual(mod.parseRewindInput('preview ck-abc'), { verb: 'preview', arg: 'ck-abc' });
  assert.deepStrictEqual(mod.parseRewindInput('step 2'), { verb: 'execute', arg: '2' });
  assert.deepStrictEqual(mod.parseRewindInput('2'), { verb: 'execute', arg: '2' });
  assert.deepStrictEqual(mod.parseRewindInput('guard ck-guard-1'), { verb: 'guard', arg: 'ck-guard-1' });
  assert.deepStrictEqual(mod.parseRewindInput('ck-abc'), { verb: 'execute', arg: 'ck-abc' });
  assert.deepStrictEqual(mod.parseRewindInput('help'), { verb: 'help', arg: '' });
  // 容忍测试/调试时带斜杠的完整命令行
  assert.deepStrictEqual(mod.parseRewindInput('/rewind step 3'), { verb: 'execute', arg: '3' });
  assert.deepStrictEqual(mod.parseRewindInput('/rewind preview ck-1'), { verb: 'preview', arg: 'ck-1' });
});

test('/rewind 参数解析：大小写与空白容忍', async () => {
  const mod = await import(MODULE_URL);
  assert.deepStrictEqual(mod.parseRewindInput('  List  '), { verb: 'list', arg: '' });
  assert.deepStrictEqual(mod.parseRewindInput('\tstep\t5\t'), { verb: 'execute', arg: '5' });
});
