import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/config.json')));
cfg.globalBlocklist = [...(cfg.globalBlocklist || []), '10004'];
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(cfg));
const { pullGroupHistory, styleSourceRows } = await import('../src/history-source.js');
const { ChatStore } = await import('../src/store.js');
const group = '20002', chat = `group:${group}`, now = Date.now();
const self = '10003', owner = '10001', checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const raw = (id, ageMinutes, user = owner, extra = {}) => ({
  message_id: id, real_seq: id, group_id: Number(group), message_type: 'group',
  time: Math.floor((now - ageMinutes * 60000) / 1000), user_id: Number(user), sender: { nickname: '测试', user_id: Number(user) },
  message: [{ type: 'text', data: { text: `历史本人内容${id}` } }], ...extra
});
const m7 = raw(7, 10), m6 = raw(6, 20, self), m4 = raw(4, 30, '10004');
const m3 = raw(3, 1440, owner, { message: [{ type: 'text', data: { text: '这是目标的历史发言' } }, { type: 'image', data: { file: 'A', sub_type: 1, summary: '[动画表情]' } }] });
const m1 = raw(1, 8 * 1440);
const pages = [[m6, m7], [m3, m4, m6], [m1, m3]], calls = [];
const ob = { selfId: self, call: async (action, params) => {
  assert.equal(action, 'get_group_msg_history'); calls.push(params);
  return { messages: pages[calls.length - 1] };
} };
const result = await pullGroupHistory({ onebot: ob, groupId: group, days: 7, count: 100, now });
check('反向分页逐步使用最早消息锚点', () => assert(calls.length === 3 && calls[1].message_seq === '6' && calls[2].message_seq === '3' && calls.every(c => c.reverse_order === true)));
check('达到时间边界停止，不宣称取得QQ全部历史', () => assert(result.stopReason === 'time-boundary' && result.completeQQHistory === false));
const file = path.join(temp, `history/group_${group}.json`);
const archived = JSON.parse(fs.readFileSync(file));
check('锚点重叠去重，过滤时间外与屏蔽用户', () => assert.deepEqual(archived.messages.map(m => m.mid), [3, 6, 7]));
check('历史行标已读，按实际登录QQ识别自己', () => assert(archived.messages.every(m => m.read) && archived.messages.find(m => m.mid === 6).self));
check('保留历史表情协议类型，不下载媒体', () => assert.equal(archived.messages[0].media[0].subType, 1));
check('历史文件权限600', () => assert.equal(fs.statSync(file).mode & 0o777, 0o600));
const store = new ChatStore();
store.appendIncoming(chat, { mid: 7, ts: m7.time * 1000, senderId: owner, text: '当前实时消息7' });
store.appendIncoming(chat, { mid: 99, ts: now, senderId: owner, text: '最新实时消息99' });
const before = fs.readFileSync(path.join(temp, `messages/group_${group}.json`), 'utf8');
const combined = styleSourceRows(store, group);
check('只扩展实时存档更早边界，重叠区用实时原记录', () => assert(combined.historyMessages === 2 && combined.rows.length === 4 && combined.rows.find(m => m.mid === 7).text === '当前实时消息7'));
check('读取历史不改变实时未读数或消息文件', () => assert(store.unreadCount(chat) === 2 && fs.readFileSync(path.join(temp, `messages/group_${group}.json`), 'utf8') === before));
let requests = 0;
const next = await pullGroupHistory({ onebot: { selfId: self, call: async (_action, params) => {
  requests++; assert.equal(params.message_seq, '3'); return { messages: [m3] };
} }, groupId: group, now });
check('再次补拉从已有最早锚点继续，无更早进展立即停', () => assert(requests === 1 && next.stopReason === 'no-older-progress'));
let errors = 0;
const failed = await pullGroupHistory({ onebot: { selfId: self, call: async () => { errors++; throw new Error('模拟旧消息锚点不存在'); } }, groupId: group, now });
check('接口失败不重试，保留明确错误及已有数据', () => assert(errors === 1 && failed.error.includes('锚点不存在') && failed.storedTotal === 3 && failed.stopReason === 'api-error'));
await assert.rejects(() => pullGroupHistory({ onebot: ob, groupId: '400029', now }), /白名单/); checks.push('白名单外不能补拉');
let denied = false;
await assert.rejects(() => pullGroupHistory({ onebot: { selfId: self, call: async () => { denied = true; return { messages: [raw(9, 1, owner, { group_id: '40006' })] }; } }, groupId: group, now }), /身份/);
check('拒绝接口混入其他群消息', () => assert(denied));
const receipt = { passed: checks.length, checks, temp, realQQSends: 0, modelCalls: 0 };
fs.writeFileSync(path.join(root, 'data/history-source-verification.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
