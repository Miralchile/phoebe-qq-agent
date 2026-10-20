import { roleResponse, roleSections } from './style-role-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-style-options-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const config = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/config.json')));
config.phoebe.sticker_probability=1;
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(config));
fs.copyFileSync(path.join(root, 'test/fixtures/phoebe-catalog.json'), path.join(temp, 'phoebe-catalog.json'));
fs.copyFileSync(path.join(root, 'test/fixtures/phoebe-names.json'), path.join(temp, 'phoebe-names.json'));
const { styleLimits, selectStyleSource, collectStyleStickers, StyleProfiles } = await import('../src/style-profiles.js');
const { groupStickerPool } = await import('../src/group-stickers.js');
const { sendPhoebeReply, phoebeContext } = await import('../src/phoebe.js');
const { extractMediaFromSegments } = await import('../src/onebot.js');
const { SessionRegistry } = await import('../src/sessions.js');
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const group = '20002', chat = `group:${group}`, user = '10001', now = Date.now();
const make = (mid, old = false) => ({ mid, senderId: user, text: '这是目标本人有内容的发言', ts: now - (old ? 40 : 0.2) * 86400000, self: false, media: [] });
const rows = Array.from({ length: 120 }, (_, i) => make(i + 1, i < 70));
const storeFor = data => ({ getChatMeta: () => ({ total: data.length }), recent: (_chat, { limit }) => data.slice(-limit) });
const store = storeFor(rows);
check('仅天数不隐含300条限制', () => assert.deepEqual(styleLimits({ days: 7 }), { days: 7, count: null }));
check('仅条数不隐含30天限制', () => assert.deepEqual(styleLimits({ count: 1000 }), { days: null, count: 1000 }));
check('双空保留默认30天300条', () => assert.deepEqual(styleLimits({ days: '', count: '' }), { days: 30, count: 300 }));
check('仅天数按时间筛选', () => assert.equal(selectStyleSource(store, group, user, { days: 1, now }).samples.length, 50));
check('仅条数可以覆盖40天前记录', () => assert.equal(selectStyleSource(store, group, user, { count: 100, now }).samples.filter(s => s.ts < now - 30 * 86400000).length, 50));
check('双参数同时约束', () => assert.equal(selectStyleSource(store, group, user, { days: 1, count: 20, now }).samples.length, 20));
check('显式留空参数同样有效', () => assert.equal(selectStyleSource(store, group, user, { days: '', count: 100, now }).samples.length, 100));
check('条数上限2000生效', () => assert.deepEqual(styleLimits({ count: 2000 }), { days: null, count: 2000 }));
check('超过2000报错', () => assert.throws(() => styleLimits({ count: 2001 }), /2000/));
check('非法天数仍报错', () => assert.throws(() => styleLimits({ days: 'abc' }), /天数/));
const large = Array.from({ length: 2050 }, (_, i) => make(i + 1));
const capped = selectStyleSource(storeFor(large), group, user, { days: 1, now });
check('仅天数超过上限时标记截断且取最新2000条', () => assert(capped.samples.length === 2000 && capped.samples[0].id === '51' && capped.hardCapReached));
const wide = [...rows, ...Array.from({ length: 5100 }, (_, i) => ({ ...make(10000 + i), senderId: '10002' }))];
check('不再被群消息5000条扫描截尾', () => assert.equal(selectStyleSource(storeFor(wide), group, user, { count: 100, now }).samples.length, 100));
const media = (file, subType = 1) => ({ kind: 'image', file, subType, summary: '[动画表情]' });
const stickerRows = [
  { ...make(1), media: [media('A')] },
  { ...make(2), media: [{ kind: 'image', file: 'A', summary: '[动画表情]' }] },
  { ...make(3), senderId: '10002', media: [media('A')] },
  { ...make(4), media: [media('B')] },
  { ...make(5), media: [media('A', 0)] },
  { ...make(6), media: [media('C')] },
  { ...make(7), recalled: true, media: [media('A')] },
  { ...make(8), isForward: true, media: [media('A')] },
  { ...make(9, true), media: [media('A')] }
];
const dir = path.join(temp, `group-stickers/group_${group}`);
fs.mkdirSync(dir, { recursive: true });
const items = [{ id: 'a', sourceFile: 'A', file: 'a.webp' }, { id: 'b', sourceFile: 'B', file: 'b.webp' }];
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(items));
const bytes = fs.readFileSync(path.join(config.phoebe.imageCache, '139.webp'));
for (const item of items) fs.writeFileSync(path.join(dir, item.file), bytes);
const stickers = collectStyleStickers(groupStickerPool, group, user, { rows: stickerRows, stickerSince: now - 86400000, now });
check('表情按实际发送QQ统计，排除照片、撤回、转发和时间外记录', () => assert(stickers.observed === 4 && stickers.available === 3 && stickers.missing === 1));
check('记录本人发送频率和真实消息证据', () => assert.deepEqual(stickers.items.map(s => ({ id: s.id, count: s.count, ids: s.messageIds })), [{ id: 'a', count: 2, ids: ['1', '2'] }, { id: 'b', count: 1, ids: ['4'] }]));
check('新媒体存档保留协议表情类型', () => assert.equal(extractMediaFromSegments([{ type: 'image', data: { file: 'A', sub_type: 1 } }])[0].subType, 1));
check('两倍使用频率对应更大抽样区间', () => assert(groupStickerPool.pickForStyle(chat, stickers.items, 0.65).id === 'a' && groupStickerPool.pickForStyle(chat, stickers.items, 0.68).id === 'b'));
groupStickerPool.markUsed(chat, { id: 'a' });
check('多张个人表情避免连续重复', () => assert.equal(groupStickerPool.pickForStyle(chat, stickers.items, 0).id, 'b'));
check('画像引用已丢失图片索引时直接报错', () => assert.throws(() => groupStickerPool.pickForStyle(chat, [{ id: 'missing', count: 2 }]), /索引/));
const service = new StyleProfiles({ store, sessions: {} });
const profile = { id: 'style-sticker-test', groupId: group, userId: user, name: '本人表情测试', samples: [], roleSections: roleSections(), card: { summary: '简短直接', traits: [{dimension:'互动策略',description:'简短直接',evidence:['1','2']}], exampleIds: [] }, stickers };
service.activate(chat, profile);
const sent = [];
const onebot = { call: async (action, params) => { sent.push({ action, params }); return { message_id: 1 }; } };
fs.writeFileSync(path.join(temp,'group-stickers/labels.json'),JSON.stringify(Object.fromEntries(items.map(i=>[i.id,{status:'ready',emotions:['开心'],description:'测试表情',useWhen:'轻松回应'}]))));
const respond = text => { phoebeContext({chatKey:chat,store:{recent:()=>[]},triggerEntries:[{senderId:user,text}],selfId:'10003',accountNickname:'菲比'});return sendPhoebeReply(onebot,chat,text,{groupStickerId:'g1'}); };
const result = await respond('这个想法可以。');
check('切换风格后单独发送本人表情', () => assert(result.groupSticker === 'b' && sent.length === 2 && sent[1].params.message.length === 1 && sent[1].params.message[0].type === 'image' && sent[0].params.message.some(s => s.type === 'text')));
const personA = { ...profile, id: 'person-A', name: 'A风格', stickers: { items: [{ id: 'a', count: 8 }] } };
const personB = { ...profile, id: 'person-B', name: 'B风格', userId: '10002', stickers: { items: [{ id: 'b', count: 5 }] } };
service.activate(chat, personA);
const a = await respond('A的回应');
service.activate(chat, personB);
const b = await respond('B的回应');
service.activate(chat, personA);
const aAgain = await respond('A再次回应');
check('A切B再切A，表情库始终绑定当前人格', () => assert(a.groupSticker === 'a' && b.groupSticker === 'b' && aAgain.groupSticker === 'a'));
service.activate(chat, { ...personA, id: 'no-personal-sticker', stickers: { items: [] } });
const noPersonal = await sendPhoebeReply(onebot, chat, '没有个人表情的回应', { stickerId: 139 });
check('无个人表情时不混用其他群友收藏', () => assert(noPersonal.phoebeMeme === 139 && !noPersonal.groupSticker));
service.restore(chat);
// Spy only the extraction boundary: command omission and explicit empty values.
const received = [];
service.extract = async args => { received.push(args); return { name: '参数测试', sampleCount: 10, firstTs: now, lastTs: now, stickers: { items: [], observed: 0, available: 0, missing: 0 } }; };
for (const suffix of ['天数=7', '条数=1000', '天数= 条数=1000', '天数=7 条数=', '天数=7 条数=1000']) {
  await service.command({ chatKey: chat, senderId: user, text: '/人格 提取 QQ=10001 名称=参数测试 ' + suffix });
}
check('命令同时接受省略、显式空值和双参数', () => assert.deepEqual(received.map(r => styleLimits(r)), [
  { days: 7, count: null }, { days: null, count: 1000 }, { days: null, count: 1000 }, { days: 7, count: null }, { days: 7, count: 1000 }
]));
const sessions = new SessionRegistry();
let calls = 0;
const largeService = new StyleProfiles({ store: storeFor(large), sessions, model: async ({ messages, toolChoice }) => {
  calls++;
  if (toolChoice.function.name === 'submit_role_prompt') return roleResponse();
  const payload = JSON.parse(messages[1].content);
  const ids = payload.samples ? payload.samples.map(s => s.id) : [...new Set(payload.cards.flatMap(c => c.exampleIds))];
  return { message: { tool_calls: [{ type: 'function', function: { name: 'submit_style_card', arguments: JSON.stringify({ summary: '试验', traits: [{ dimension: '表达形式', description: '简短', evidence: ids.slice(0, 2) }], exampleIds: ids.slice(0, 2) }) } }] }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
} });
try {
  const p = await largeService.extract({ groupId: group, userId: user, name: '千条试验', count: 1000 });
  check('1000条完整分段提取与合并通过，记录全部19次调用含提示词生成', () => assert(p.sampleCount === 1000 && calls === 19 && sessions.get(p.sessionId).usage.calls === 19));
} finally { sessions.flushIndexCache(); }
const resultSummary = { passed: checks.length, checks, temp, realQQSends: 0, realModelCalls: 0 };
fs.writeFileSync(path.join(root, 'data/style-options-stickers-verification.json'), JSON.stringify(resultSummary, null, 2));
console.log(JSON.stringify(resultSummary, null, 2));
