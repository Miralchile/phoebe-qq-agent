import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { ChatStore } from '../../src/store.js';
import { extractMediaFromSegments, segmentsToText } from '../../src/onebot.js';

const attempted = new Set(), summaries = new Map(), baseline = new Map();
let log;
export function setup(api) {
  log = api.log;
  const store = new ChatStore();
  for (const id of getConfig().allow.groups) baseline.set(`group:${id}`, store.getChatMeta(`group:${id}`).lastTs);
}
async function query(action, params) {
  const c = getConfig().snowluma;
  const token = c.httpAccessToken || c.accessToken;
  const response = await fetch(`${c.httpUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params), signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) throw new Error(`补课接口HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(`补课接口${action}失败：${body.wording || body.retcode}`);
  return body.data;
}
export const hooks = {
  async 'before-context'(ctx) {
    if (ctx.kind !== 'group' || attempted.has(ctx.chatKey) || !baseline.has(ctx.chatKey)) return;
    attempted.add(ctx.chatKey);
    try {
      const [login, data] = await Promise.all([
        query('get_login_info', {}), query('get_group_msg_history', {
          group_id: ctx.chatId, count: 100, reverse_order: false, parse_mult_msg: false, disable_get_url: true
        })
      ]);
      if (!Array.isArray(data.messages)) throw new Error('补课接口未返回消息数组');
      const cutoff = baseline.get(ctx.chatKey) || Date.now() - 86400000;
      const triggerTime = Math.min(...ctx.triggerEntries.map(e => e.ts));
      const cfg = getConfig();
      const blocked = new Set([...(cfg.globalBlocklist || []), ...(cfg.blocklist?.[ctx.chatId] || [])].map(String));
      const selected = data.messages.filter(m => String(m.group_id) === ctx.chatId && m.time * 1000 > cutoff && m.time * 1000 < triggerTime && !blocked.has(String(m.user_id)));
      const rows = [];
      for (const m of selected) {
        if (!Array.isArray(m.message)) throw new Error('补课消息缺少OneBot数组格式');
        const self = String(m.user_id) === String(login.user_id);
        rows.push({ mid: m.message_id, ts: m.time * 1000, senderId: self ? 'self' : String(m.user_id),
          senderName: m.sender?.card || m.sender?.nickname || String(m.user_id), self,
          text: await segmentsToText(m.message), media: extractMediaFromSegments(m.message),
          isForward: m.message.some(s => s.type === 'forward'), atMe: false, atNames: [], reply: null });
      }
      const added = ctx.store.mergeReadHistory(ctx.chatKey, rows);
      const partial = data.messages.length > 0 && Math.min(...data.messages.map(m => m.time * 1000)) > cutoff;
      summaries.set(ctx.chatKey, `补看${added}条已读历史，仅查询最近100条，${partial ? '仍可能缺少更早的离线消息' : '不保证QQ历史完整'}。旧内容只用于理解话题，不逐条补答、不补执行旧命令。`);
      const dir = path.join(DATA_DIR, 'offline-study'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ctx.chatId}.json`), JSON.stringify({ at: Date.now(), since: cutoff, added, queried: data.messages.length, partial, autoReply: false }), { mode: 0o600 });
      log(summaries.get(ctx.chatKey));
    } catch (error) {
      summaries.set(ctx.chatKey, `本次离线补课失败：${error.message}。未假定已读到缺失历史，不自动重试。`);
      log(summaries.get(ctx.chatKey));
    }
  },
  'before-llm-messages'(ctx) {
    const summary = summaries.get(ctx.chatKey);
    if (summary) {
      ctx.messages[1].content += `\n【离线补课简报】${summary}`;
      summaries.delete(ctx.chatKey);
    }
  }
};
