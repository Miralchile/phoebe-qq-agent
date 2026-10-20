import { roleResponse } from './style-role-fixture.mjs';
// Exercise the real model client with a virtual clock; no network or QQ sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-style-timeout-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/config.json')));
cfg.api.timeoutMs = 90000;
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(cfg));
const { getConfig } = await import('../src/config.js');
const { chatCompletion } = await import('../src/llm.js');
const { StyleProfiles } = await import('../src/style-profiles.js');
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const store = new ChatStore(), sessions = new SessionRegistry();
for (let i = 1; i <= 10; i++) store.appendIncoming('group:20002', {
  mid: i, senderId: '10001', text: `这次先听你的理由，再看看怎么做，第${i}条。`
});
const service = new StyleProfiles({ store, sessions });
const originalFetch = globalThis.fetch;
let delayMs = 90001, requests = 0;
mock.timers.enable({ apis: ['setTimeout'] });
globalThis.fetch = async (_url, options) => {
  requests++;
  mock.timers.tick(delayMs);
  if (options.signal.aborted) throw options.signal.reason;
  const body = JSON.parse(options.body);
  if (body.tool_choice.function.name === 'submit_role_prompt') return new Response(JSON.stringify({ choices: [{ message: roleResponse().message }], usage: roleResponse().usage }), { headers: { 'content-type': 'application/json' } });
  const payload = JSON.parse(body.messages[1].content);
  const ids = payload.samples.map(s => s.id);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
    type: 'function', function: { name: 'submit_style_card', arguments: JSON.stringify({
      summary: '先追问理由，再表达态度。',
      traits: [{ dimension: '互动策略', description: '先让对方解释理由。', evidence: ids.slice(0, 2) }],
      exampleIds: ids.slice(0, 2)
    }) }
  }] } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }), {
    headers: { 'content-type': 'application/json' }
  });
};
try {
  await assert.rejects(chatCompletion({ messages: [{ role: 'user', content: '你好' }] }), /请求超时/);
  const profile = await service.extract({ groupId: '20002', userId: '10001', name: '超过90秒仍成功', count: 10 });
  assert.equal(profile.sampleCount, 10);
  assert.equal(sessions.get(profile.sessionId).status, 'done');
  assert.equal(getConfig().api.timeoutMs, 90000);
  delayMs = 180001;
  await assert.rejects(service.extract({ groupId: '20002', userId: '10001', name: '超过180秒失败', count: 10 }), /请求超时/);
  assert.equal(requests, 4, '失败不自动重试');
  assert.equal(service.busy, false);
  assert.deepEqual(service.list('20002').map(p => p.name), ['超过90秒仍成功']);
  console.log(JSON.stringify({ passed: 3, checks: ['聊天仍在90秒超时', '人格提取超过90秒可成功保存', '人格提取超过180秒失败且不保存或重试'], realModelCalls: 0, realQQSends: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  sessions.flushIndexCache();
  mock.timers.reset();
}
