import { roleResponse, roleSections } from './style-role-fixture.mjs';
import { validateRolePrompt } from '../src/style-role-prompt.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-style-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/config.json')));
cfg.phoebe.sticker_probability=1;
cfg.api.baseUrl = 'http://127.0.0.1:8645/v1';
cfg.phoebe.styleModes = {};
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(cfg));
for (const f of ['phoebe-names.json', 'phoebe-catalog.json']) fs.copyFileSync(path.join(root, 'test/fixtures', f), path.join(temp, f));
const { getConfig, personaForChat } = await import('../src/config.js');
const { StyleProfiles, collectStyleSamples, validateStyleCard, styleMode, styleMemory, styleStore, styleUtterance } = await import('../src/style-profiles.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { SendQueue } = await import('../src/sender.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const store = new ChatStore(), memory = new MemoryStore(), sessions = new SessionRegistry();
const group = '20002', chat = `group:${group}`, user = '10001';
const now = Date.now();
for (let i = 0; i < 65; i++) {
  store.appendIncoming(chat, { mid: i + 1, ts: now - 100000 + i, senderId: user, senderName: '样本用户', text: i % 2 ? '行，先说你的理由。' : '这波有点东西，展开讲讲。' });
}
for (const [mid, fields] of [[101, { text: '[图片]' }], [102, { text: 'http://example.test' }], [103, { text: '/人格 提取' }], [104, { text: '转发的别人原话', isForward: true }], [105, { text: '别人的话', senderId: '10002' }], [106, { text: '太旧的本人消息', ts: now - 400 * 86400000 }]]) {
  store.appendIncoming(chat, { mid, ts: now - 10000, senderId: user, senderName: '样本用户', ...fields });
}
store.appendSelf(chat, { text: '旧菲比口癖：啾比啾比管理员！', ts: now - 5000 });
memory.append(chat, 'memberImpression', '原始菲比共同经历', { userId: user });
const originalRules = JSON.stringify(getConfig().phoebe.groups);
const originalPersona = personaForChat(chat).roleText;
let requests = 0;
const model = async ({ messages, tools, toolChoice }) => {
  requests++;
  if (toolChoice.function.name === 'submit_role_prompt') return roleResponse();
  assert(tools[0].function.parameters.required.includes('exampleIds') && toolChoice.function.name === 'submit_style_card');
  const data = JSON.parse(messages[1].content);
  const ids = data.samples ? data.samples.map(s => s.id) : [...new Set(data.cards.flatMap(c => c.exampleIds))];
  return { message: { tool_calls: [{ type: 'function', function: { name: 'submit_style_card', arguments: JSON.stringify({ summary: '简短直接，常追问理由。', traits: [{ dimension: '互动策略', description: '先表达简短态度，再让对方展开理由。', evidence: ids.slice(0, 2) }], exampleIds: ids.slice(0, 2) }) } }] }, usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
};
const service = new StyleProfiles({ store, sessions, model });
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
async function rejects(name, fn, pattern) { await assert.rejects(fn, pattern); checks.push(name); }
try {
  check('剔除协议引用和@但保留本人正文', () => assert.equal(styleUtterance('[引用 某人：[reply][at]内容]@某人 可以，展开讲讲。'), '可以，展开讲讲。'));
  check('用户自身括号内容正常保留', () => assert.equal(styleUtterance('有点东西（）'), '有点东西（）'));
  const samples = collectStyleSamples(store, group, user);
  check('仅取指定QQ有效消息，剔除媒体、链接、指令、转发、过期与其他人', () => assert.equal(samples.length, 65));
  check('保留上下文但不把其他人当作目标', () => assert(samples.every(s => s.context.some(c => c.id === s.id))));
  await rejects('非管理员不能提取或切换', () => service.command({ chatKey: chat, senderId: '40002', text: '/人格 使用 测试' }), /管理员/);
  await rejects('目标群须在白名单', () => service.extract({ groupId: '400029', userId: user, name: '越界' }), /参数/);
  await rejects('不接受路径作为风格名', () => service.extract({ groupId: group, userId: user, name: '../../bad' }), /参数/);
  await rejects('不接受隐式改用其他群', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 群=20003 QQ=10001 名称=越界' }), /提取/);
  await rejects('样本不足不生成伪画像', () => service.extract({ groupId: group, userId: '10002', name: '少量' }), /仅1条/);
  await rejects('拼错参数不静默忽略', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 QQ=10001 名称=错参 天=3' }), /提取/);
  const reply = await service.command({ chatKey: chat, senderId: user, text: '/人格 提取 QQ=10001 名称=测试风格' });
  const profile = service.get(group, '测试风格');
  await rejects('@多个成员拒绝提取', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 名称=多人', mentionedUserIds: [user, '10002'] }), /一次只能/);
  await rejects('@全体成员不能定位个人', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 名称=全体', mentionedUserIds: ['all'] }), /全体/);
  await rejects('@与显式QQ冲突时不猜测目标', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 QQ=10002 名称=冲突', mentionedUserIds: [user] }), /不同的人/);
  await rejects('手打昵称不能代替真实@定位', () => service.command({ chatKey: chat, senderId: user, text: '/人格 提取 名称=缺少目标' }), /选择器/);
  check('模型缺少必需的示例编号时拒绝保存', () => {
    const { exampleIds, ...missingExamples } = profile.card;
    assert.throws(() => validateStyleCard(JSON.stringify(missingExamples), samples), /JSON字段/);
  });
  check('分段65条、合并并生成完整提示词，4次调用，草稿不激活', () => assert(requests === 4 && !styleMode(chat) && reply.includes('尚未切换')));
  check('用量进入现有会话记录', () => assert.equal(sessions.get(profile.sessionId).usage.calls, 4));
  check('完整提示词章节保留、空证据维度不补造', () => assert(profile.roleSections[0].text && profile.roleSections.slice(1).every(s => !s.text && !s.traitIndexes.length)));
  check('提示词不能引用不存在的侧写', () => {
    const sections = roleSections(); sections[0].traitIndexes = [2];
    assert.throws(() => validateRolePrompt(JSON.stringify({ sections }), profile.card), /证据编号/);
  });
  check('有行为规则必须提供侧写依据', () => {
    const sections = roleSections(); sections[0].traitIndexes = [];
    assert.throws(() => validateRolePrompt(JSON.stringify({ sections }), profile.card), /证据编号/);
  });
  const fullPrompt = await service.command({ chatKey: chat, senderId: user, text: '/人格 提示词 测试风格' });
  check('可查看完整提示词，真实示例与规则分开', () => assert(fullPrompt.includes('# 多轮互动') && fullPrompt.includes('# 真实表达示例') && fullPrompt.includes('这波有点东西') && fullPrompt.includes('traitIndexes') === false));
  const priorSession = profile.promptSessionId;
  const refined = await service.refine({ groupId: group, name: profile.name });
  check('完善只调用一次模型、保留样本表情和人格ID、不激活', () => assert(requests === 5 && refined.id === profile.id && refined.sampleCount === profile.sampleCount && refined.promptSessionId !== priorSession && !styleMode(chat) && JSON.stringify(refined.stickers) === JSON.stringify(profile.stickers)));
  const beforeFailedRefine = JSON.stringify(service.get(group, profile.name));
  const failRefine = new StyleProfiles({ store, sessions, model: async () => { throw new Error('完善HTTP403'); } });
  await rejects('完善失败直接报错', () => failRefine.refine({ groupId: group, name: profile.name }), /完善HTTP403/);
  check('完善失败保留已有提示词和画像、不重试', () => assert.equal(JSON.stringify(service.get(group, profile.name)), beforeFailedRefine));
  check('画像文件权限600', () => assert.equal(fs.statSync(path.join(temp, 'style-profiles.json')).mode & 0o777, 0o600));
  check('拒绝不存在的消息证据', () => assert.throws(() => validateStyleCard(JSON.stringify({ ...profile.card, exampleIds: ['99999', '1'] }), samples), /无效/));
  check('单条发言不能构成稳定特征', () => assert.throws(() => validateStyleCard(JSON.stringify({ ...profile.card, traits: [{ ...profile.card.traits[0], evidence: ['1'] }] }), samples), /证据/));
  await rejects('不覆盖同名旧版本', () => service.extract({ groupId: group, userId: user, name: '测试风格' }), /已存在/);
  const preview = await service.command({ chatKey: `private:${user}`, senderId: user, text: `/人格 查看 测试风格 群=${group}` });
  check('管理员私聊能预览，普通群无需广播全部原始样本', () => assert(preview.includes('证据2条') && preview.includes('示例')));
  await rejects('群有在途回复时不切换', () => service.command({ chatKey: chat, senderId: user, text: '/人格 使用 测试风格', busy: true }), /正在回复/);
  await rejects('私聊不隐式切换群', () => service.command({ chatKey: `private:${user}`, senderId: user, text: `/人格 使用 测试风格 群=${group}` }), /对应群/);
  await service.command({ chatKey: chat, senderId: user, text: '/人格 使用 测试风格' });
  const activeBeforeRefine = JSON.stringify(styleMode(chat));
  await service.refine({ groupId: group, name: profile.name });
  check('完善当前画像不隐式刷新正在使用的人格、激活时间或表情绑定', () => assert.equal(JSON.stringify(styleMode(chat)), activeBeforeRefine));
  const mode = styleMode(chat);
  check('按群人设覆盖生效', () => assert(personaForChat(chat).roleText.includes('简短直接') && !personaForChat(chat).roleText.includes('# 九、')));
  check('其他群保持原人设', () => assert.equal(personaForChat('group:20003').roleText, originalPersona));
  const scoped = styleMemory(memory, chat, mode);
  check('新风格不读原菲比记忆', () => assert.equal(scoped.query(chat).memberImpression.length, 0));
  scoped.append(chat, 'memberImpression', '新风格互动经历', { userId: user });
  check('新记忆不污染原记忆', () => assert.equal(memory.query(chat).memberImpression.length, 1));
  const scopedStore = styleStore(store, chat, mode);
  check('新风格上下文不带旧菲比自身发言', () => assert(!scopedStore.recent(chat).some(r => r.self)));
  check('记忆层拒绝跨群调用', () => assert.throws(() => scoped.query('group:20003'), /当前群/));
  await rejects('启用中的画像不可删除', () => service.command({ chatKey: chat, senderId: user, text: '/人格 删除 测试风格' }), /仍在使用/);
  const originalFetch = globalThis.fetch;
  const sends = [], bodies = [], ends = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).endsWith('/chat/completions')) throw new Error(`未预期网络请求${url}`);
    const body = JSON.parse(opts.body); bodies.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 's1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: '这波有点东西，展开讲讲。', stickerId: 139 }) } },
      { id: 'f1', type: 'function', function: { name: 'finish', arguments: '{"reason":"已回应"}' } }
    ] } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }), { headers: { 'content-type': 'application/json' } });
  };
  const onebot = { selfId: '10003', selfNickname: '测试机器人', getGroupInfo: async () => ({ group_name: '独立风格实验' }), call: async (action, params) => {
    if (action === 'send_group_msg') { sends.push(params); return { message_id: 999 }; }
    if (action === 'get_group_member_info') return {};
    throw new Error(action);
  } };
  const sender = new SendQueue({ onebot, store });
  const orchestrator = new Orchestrator({ store, memory, sessions, sender, onebot, stickers: { sync: async () => ({ entries: [] }) }, emit: (type, data) => { if (type === 'session-end') ends.push(data); } });
  try {
    store.drainUnread(chat);
    store.appendIncoming(chat, { mid: 200, senderId: user, senderName: '样本用户', text: '你觉得这个主意如何？', atMe: true });
    await orchestrator.wake(chat);
    const session = sessions.get(ends.at(-1).sessionId);
    if (session.status !== 'done') console.error(JSON.stringify({ status: session.status, error: session.error, finishReason: session.finishReason, temp }));
    check('真实编排器使用风格提示和独立记忆', () => assert(session.status === 'done' && bodies[0].messages[1].content.includes('新风格互动经历') && !bodies[0].messages[1].content.includes('原始菲比共同经历')));
    check('每次风格回复仍有文字和图片且不发送到真实QQ', () => assert(sends.length === 2 && sends[0].message.some(s => s.type === 'text') && sends[1].message.length === 1 && sends[1].message[0].type === 'image'));
  } finally { globalThis.fetch = originalFetch; await orchestrator.abortAll(); }
  await service.command({ chatKey: chat, senderId: user, text: '/人格 恢复菲比' });
  check('恢复原人设与记忆', () => assert(personaForChat(chat).roleText === originalPersona && styleMemory(memory, chat, styleMode(chat)) === memory));
  await service.command({ chatKey: chat, senderId: user, text: '/人格 使用 测试风格' });
  check('再次切换仍保留该风格互动记忆', () => assert.equal(styleMemory(memory, chat, styleMode(chat)).query(chat).memberImpression.length, 1));
  await service.command({ chatKey: chat, senderId: user, text: '/人格 恢复菲比' });
  await service.command({ chatKey: chat, senderId: user, text: '/人格 删除 测试风格' });
  check('删除指定画像及其独立记忆文件', () => assert(service.list(group).length === 0 && !fs.existsSync(path.join(temp, 'memory', `${chat}:style:${mode.profileId}`.replace(/[^a-z0-9_]/gi, '_')))));
  check('概率与冷却规则保持原值', () => assert.equal(JSON.stringify(getConfig().phoebe.groups), originalRules));
  const failed = new StyleProfiles({ store, sessions, model: async () => { throw new Error('模拟HTTP403'); } });
  await rejects('模型拒绝直接报错，不重试、不保存', () => failed.extract({ groupId: group, userId: user, name: '失败' }), /HTTP403/);
  check('失败不生成画像且释放提取锁', () => assert(!failed.busy && failed.list(group).length === 0));
  let invalidRoleCalls = 0;
  const invalidRole = new StyleProfiles({ store, sessions, model: async args => {
    invalidRoleCalls++;
    if (args.toolChoice.function.name !== 'submit_role_prompt') return model(args);
    const response = roleResponse();
    const sections = roleSections(); sections[0].traitIndexes = [24];
    response.message.tool_calls[0].function.arguments = JSON.stringify({ sections });
    return response;
  } });
  await rejects('最终提示词引用无效证据则提取失败', () => invalidRole.extract({ groupId: group, userId: user, name: '错误提示词', count: 10 }), /证据编号/);
  check('最终阶段失败不保存半成品、不重试', () => assert(invalidRoleCalls === 2 && !invalidRole.list(group).some(p => p.name === '错误提示词') && !invalidRole.busy));
  // Exercise app.js ingestion rather than just calling the command parser.
  fs.writeFileSync(path.join(temp, 'style-profiles.json'), JSON.stringify({ profiles: [profile] }), { mode: 0o600 });
  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  const sessionCountBeforeCommands = app.sessions.index.length;
  const commandReplies = [];
  const atExtractions = [];
  const originalExtract = StyleProfiles.prototype.extract;
  StyleProfiles.prototype.extract = async args => { atExtractions.push(args); return profile; };
  app.onebot.selfInfo = { user_id: '10003', nickname: '测试机器人' };
  app.onebot.call = async action => { if (action === 'get_group_member_info') return { nickname: '菲比' }; throw new Error(`应用测试拒绝真实QQ调用：${action}`); };
  app.sender.sendTextBatch = async (_chat, text) => { commandReplies.push(text); return { sent: [{ text }] }; };
  const event = (who, text, withAt = false, g = group) => ({ post_type: 'message', message_type: 'group', group_id: g, user_id: who, sender: { user_id: who, nickname: '测试者' }, message_id: 8801,
    message: [...(withAt ? [{ type: 'at', data: { qq: '10003' } }] : []), { type: 'text', data: { text } }] });
  try {
    const atExtract = event(user, '/人格 提取 名称=真实艾特 天数=5 条数=');
    atExtract.message.unshift({ type: 'at', data: { qq: '10003' } }, { type: 'at', data: { qq: user } });
    await app.onebot.onEvent(atExtract);
    check('应用入口从协议@定位目标且排除机器人', () => assert(atExtractions.length === 1 && atExtractions[0].userId === user && atExtractions[0].days === '5' && atExtractions[0].count === ''));
    const deniedExtract = event('40002', '/人格 提取 名称=越权');
    deniedExtract.message.unshift({ type: 'at', data: { qq: user } });
    await app.onebot.onEvent(deniedExtract);
    check('@提取保持真实管理员权限边界', () => assert(atExtractions.length === 1 && commandReplies.at(-1).includes('管理员')));
    await app.onebot.onEvent(event(user, '/人格 使用 测试风格', true));
    check('应用入口识别QQ真实@加命令并切换', () => assert(styleMode(chat).profileId === profile.id && commandReplies.at(-1).includes('已切换')));
    await app.onebot.onEvent(event('40002', '/人格 恢复菲比'));
    check('应用入口拒绝普通群友切换', () => assert(styleMode(chat).profileId === profile.id && commandReplies.at(-1).includes('管理员')));
    await app.onebot.onEvent(event(user, '/人格 恢复菲比'));
    check('应用入口无@恢复命令生效且不交聊天模型', () => assert(!styleMode(chat).profileId && commandReplies.at(-1).includes('已恢复') && app.sessions.index.length === sessionCountBeforeCommands));
    const before = commandReplies.length;
    await app.onebot.onEvent(event(user, '/人格 列表', false, '40006'));
    check('应用入口白名单外命令不处理', () => assert.equal(commandReplies.length, before));
  } finally { StyleProfiles.prototype.extract = originalExtract; await app.stop(); }
  const result = { passed: checks.length, checks, temp, capturedQQSends: sends.length, realQQSends: 0 };
  fs.writeFileSync(path.join(root, 'data/style-profiles-offline-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { sessions.flushIndexCache(); }
