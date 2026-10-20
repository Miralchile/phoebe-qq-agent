import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-grok-images-'));
process.env.QQ_AGENT_DATA_DIR = temp;
for (const file of ['config.json', 'phoebe-names.json', 'phoebe-catalog.json']) fs.copyFileSync(path.join(root, 'test/fixtures', file), path.join(temp, file));
const { imageRequest, generateGrokImage, GrokImages } = await import('../src/grok-images.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSt8AAAAASUVORK5CYII=';
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
check('明确@生图指令与自然表达可识别', () => {
  for (const text of ['/生图 橘猫', '帮我生成一张窗边橘猫的水彩图', '帮我画一只戴红围巾的小狗', '画一幅海边风景']) assert(imageRequest(text, true));
});
check('普通闲聊及未@的请求不触发生图', () => {
  for (const text of ['你会画画吗', '这张图画得真好', '帮我生成一个人格']) assert.equal(imageRequest(text, true), null);
  assert.equal(imageRequest('帮我画一只猫', false), null);
});
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (url, options) => {
  requests++;
  assert.equal(url, 'http://hermes:8645/v1/images/generations');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'grok-imagine-image'); assert.equal(body.n, 1);
  assert.equal(options.headers.authorization, undefined);
  return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
};
let app;
try {
  const image = await generateGrokImage('测试');
  check('固定OAuth代理单张请求并得到真实图片字节', () => assert(image.mime === 'image/png' && image.bytes > 0 && requests === 1));
  globalThis.fetch = async () => { requests++; return new Response('not entitled', { status: 403 }); };
  await assert.rejects(() => generateGrokImage('测试失败'), /HTTP 403/);
  check('上游拒绝只请求一次且不切换付费Key', () => assert.equal(requests, 2));
  let release;
  let generated = 0;
  const sent = [];
  const service = new GrokImages({ sendMedia: async (...args) => sent.push(args) }, async () => {
    generated++;
    await new Promise(resolve => { release = resolve; });
    return image;
  });
  const first = service.reply('group:20002', '橘猫', 123);
  await assert.rejects(() => service.reply('group:20002', '另一只猫', 124), /仍在生成/);
  release(); await first;
  check('生成期间不重复调用，同一气泡引用原消息并发送文字图片', () => {
    assert.equal(generated, 1); assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][1].map(x => x.type), ['reply', 'text', 'image']);
    assert.equal(sent[0][1][0].data.id, '123'); assert(sent[0][1][2].data.file.startsWith('base64://'));
    assert.equal(service.pending.size, 0);
  });
  const failed = new GrokImages({}, async () => { throw new Error('生成失败'); });
  await assert.rejects(() => failed.reply('group:20002', '猫', 125), /生成失败/);
  check('失败释放状态且不发送假成功结果', () => assert.equal(failed.pending.size, 0));
  const { createApp } = await import('../src/app.js');
  app = createApp({ log: () => {} });
  app.onebot.selfInfo = { user_id: '10003', nickname: '测试机器人' };
  app.onebot.call = async action => { if (action === 'get_group_member_info') return { nickname: '菲比' }; throw new Error(`测试禁止真实QQ调用：${action}`); };
  let chatCalls = 0, complete;
  const delivered = new Promise(resolve => { complete = resolve; });
  app.orchestrator.onIncoming = () => chatCalls++;
  app.sender.sendMedia = async (...args) => { sent.push(args); complete(); return { message_id: 789 }; };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  const event = { post_type: 'message', message_type: 'group', group_id: '20002', user_id: '10001', sender: { user_id: '10001', nickname: '测试者' }, message_id: 456,
    message: [{ type: 'at', data: { qq: '10003' } }, { type: 'text', data: { text: '帮我画一只橘猫' } }] };
  await app.onebot.onEvent(event);
  await delivered;
  check('真实入站分派保留请求存档，生图不再交聊天模型重复回复', () => assert(chatCalls === 0 && app.store.findByMid('group:20002', 456).read));
  const before = sent.length;
  await app.onebot.onEvent({ ...event, group_id: '40006' });
  check('白名单外的生图请求不能执行', () => assert.equal(sent.length, before));
  console.log(JSON.stringify({ passed: checks.length, checks, realModelCalls: 0, realQQSends: 0 }));
} finally {
  if (app) await app.stop();
  globalThis.fetch = originalFetch;
}
