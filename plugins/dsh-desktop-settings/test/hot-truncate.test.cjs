'use strict';
// 无感热回滚：truncateSessionInMemory 内存日志收缩单测（不重启 Harness 的路径）
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href;

function fakeSession(events) {
  const log = [...events];
  const session = { log, eventsSnapshot: Object.freeze([...log]) };
  return session;
}

test('热截断：已结束轮次原地收缩内存日志', async () => {
  const mod = await import(MODULE_URL);
  const events = [
    { type: 'session/end-seed', seq: 0 },
    { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ id: 'm1' }] } },
    { type: 'user/message', seq: 2, data: { id: 'm1' } },
    { type: 'turn/start', seq: 3 },
    { type: 'assistant/message', seq: 4 },
    { type: 'turn/end', seq: 5 },
    { type: 'agent/inbox/spliced', seq: 6, data: { inserted: [{ id: 'm2' }] } },
    { type: 'user/message', seq: 7, data: { id: 'm2' } }
  ];
  const session = fakeSession(events);
  mod.liveSessions.set('s-hot', session);
  const result = mod.truncateSessionInMemory('s-hot', 'm2');
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.equal(session.log.length, 6);
  assert.equal(session.log.at(-1).type, 'turn/end');
  assert.equal(session.eventsSnapshot, undefined);
  mod.liveSessions.delete('s-hot');
});

test('热截断：轮次未结束拒绝原地收缩（交给整机路径）', async () => {
  const mod = await import(MODULE_URL);
  const events = [
    { type: 'agent/inbox/spliced', seq: 0, data: { inserted: [{ id: 'm1' }] } },
    { type: 'user/message', seq: 1, data: { id: 'm1' } },
    { type: 'turn/start', seq: 2 },
    { type: 'assistant/message', seq: 3 }
  ];
  const session = fakeSession(events);
  mod.liveSessions.set('s-active', session);
  const result = mod.truncateSessionInMemory('s-active', 'm1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTIVE_TURN');
  assert.equal(session.log.length, 4); // 未改动
  mod.liveSessions.delete('s-active');
});

test('热截断：会话不在线 / 消息不存在', async () => {
  const mod = await import(MODULE_URL);
  assert.equal(mod.truncateSessionInMemory('s-none', 'm1').code, 'OFFLINE');
  const session = fakeSession([{ type: 'user/message', seq: 0, data: { id: 'other' } }]);
  mod.liveSessions.set('s-other', session);
  assert.equal(mod.truncateSessionInMemory('s-other', 'm1').code, 'NO_MESSAGE');
  mod.liveSessions.delete('s-other');
});
