import { roleSections } from './style-role-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-persona-control-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/config.json')));
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(cfg));
for (const f of ['phoebe-names.json', 'phoebe-catalog.json']) fs.copyFileSync(path.join(root, 'test/fixtures', f), path.join(temp, f));
const { StyleProfiles, styleMode } = await import('../src/style-profiles.js');
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { MemoryStore } = await import('../src/memory.js');
const { SendQueue } = await import('../src/sender.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const group = '20002', chat = `group:${group}`, admin = '10001';
const store = new ChatStore(), sessions = new SessionRegistry(), memory = new MemoryStore();
const profile = { id: 'test-control', name: '切换测试', groupId: group, stickers: { items: [] },
  roleSections: roleSections(), card: { summary: '先问原因，再接话。', traits: [{dimension:'互动策略',description:'先问原因，再接话。',evidence:['1','2']}], exampleIds: [] }, samples: [] };
fs.writeFileSync(path.join(temp, 'style-profiles.json'), JSON.stringify({ profiles: [profile] }));
const service = new StyleProfiles({ store, sessions });
let sends = 0;
const onebot = { selfId: '10003', selfNickname: '菲比', getGroupInfo: async () => ({ group_name: '测试' }),
  call: async action => { if (action.startsWith('send_')) { sends++; throw new Error('禁止真实QQ发送'); } return {}; } };
const sender = new SendQueue({ onebot, store });
const bot = new Orchestrator({ store, sessions, memory, sender, onebot, stickers: { sync: async () => ({ entries: [] }) }, emit: () => {} });
const change = text => service.command({ chatKey: chat, senderId: admin, text, busy: true, runChange: action => bot.changePersona(chat, action) });
const originalFetch = globalThis.fetch;
try {
  store.appendIncoming(chat, { mid: 1, senderId: admin, text: '你好', atMe: true });
  bot.scheduleWake(chat, 60000, { verified: true });
  const previousWaiting = bot.pendingSessions.get(chat);
  await change('/人格 切换 切换测试');
  assert.equal(styleMode(chat).profileId, profile.id);
  assert.notEqual(bot.pendingSessions.get(chat), previousWaiting, '撤掉旧人格等待，重新排新人格');
  bot.abortSession(bot.pendingSessions.get(chat));
  store.drainUnread(chat);
  await change('/人格 切换菲比');
  let started;
  const modelStarted = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, opts) => {
    started();
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  };
  store.appendIncoming(chat, { mid: 2, senderId: admin, text: '给你蛋糕', atMe: true });
  const run = bot.wake(chat);
  await modelStarted;
  const oldRun = bot.activeRuns.get(chat);
  await change('/人格 使用 切换测试');
  await run;
  assert.equal(sessions.get(oldRun).status, 'aborted');
  assert.equal(styleMode(chat).profileId, profile.id);
  assert.equal(bot.runningChats.has(chat), false);
  assert.equal(sends, 0, '旧人格生成已中断，未发出旧回复');
  let controls = 0;
  await assert.rejects(service.command({ chatKey: chat, senderId: '40002', text: '/人格 恢复菲比', runChange: () => { controls++; } }), /管理员/);
  await assert.rejects(change('/人格 使用 不存在'), /没有这个风格/);
  assert.equal(controls, 0);
  assert.equal(styleMode(chat).profileId, profile.id);
  assert.equal(bot.personaChanges.size, 0);
  let startedSend, finishSend;
  const sendStarted = new Promise(resolve => { startedSend = resolve; });
  const sending = new Promise(resolve => { finishSend = resolve; });
  sender.sendTextBatch = async () => { startedSend(); await sending; return { sent: [{ text: '已开始上传的旧回复' }], failed: [] }; };
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [
    { id: 'sending', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: '已开始上传的旧回复' }) } },
    { id: 'done', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ reason: '已回复' }) } }
  ] } }] }), { headers: { 'content-type': 'application/json' } });
  store.appendIncoming(chat, { mid: 3, senderId: admin, text: '你好', atMe: true });
  const uploadingRun = bot.wake(chat);
  await sendStarted;
  const switching = change('/人格 恢复菲比');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(styleMode(chat).profileId, profile.id, '已开始的发送结束前不改变人格');
  finishSend();
  await Promise.all([uploadingRun, switching]);
  assert.equal(styleMode(chat).profileId, null);
  console.log(JSON.stringify({ passed: 5, checks: ['等待中可直接切换', '生成中中止旧轮后切换', '未授权指令不触发控制', '不存在的风格不打断或修改当前人格', '已开始发送时等发送结束再切换'], realQQSends: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  await bot.abortAll();
  sessions.flushIndexCache();
}
