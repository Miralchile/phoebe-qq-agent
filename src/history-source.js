// Explicit, bounded OneBot history reads. Stored separately from live unread messages.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { segmentsToText, extractMediaFromSegments } from './onebot.js';

const fileFor = group => path.join(DATA_DIR, 'history', `group_${group}.json`);
export function styleSourceRows(store, groupId) {
  const chat = `group:${groupId}`;
  const live = store.recent(chat, { limit: Math.max(1, store.getChatMeta(chat).total) });
  const file = fileFor(groupId);
  if (!fs.existsSync(file)) return { rows: live, historyMessages: 0, historyCoverage: null };
  const history = JSON.parse(fs.readFileSync(file, 'utf8'));
  // This feature extends the oldest boundary; it does not guess whether old short IDs
  // from another QQ login refer to the same live message. The live time range wins.
  const liveStart = live.reduce((n, r) => Math.min(n, r.ts), Infinity);
  const old = history.messages.filter(r => r.ts < liveStart);
  const rows = [...old, ...live].sort((a, b) => a.ts - b.ts);
  return { rows, historyMessages: old.length, historyCoverage: history.coverage };
}

export async function pullGroupHistory({ onebot, groupId, days = 7, count = 1000, now = Date.now() }) {
  const cfg = getConfig();
  if (!/^\d+$/.test(groupId) || !cfg.allow.groups.includes(groupId)) throw new Error('只允许补拉白名单群');
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(count) || count < 100 || count > 5000) throw new Error('补拉范围：1到365天，100到5000条群消息');
  const blocked = new Set([...(cfg.globalBlocklist || []), ...(cfg.blocklist?.[groupId] || [])].map(String));
  const selfId = String(onebot.selfId);
  if (!/^\d+$/.test(selfId)) throw new Error('需要已确认的QQ登录身份');
  const file = fileFor(groupId);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).messages : [];
  const cutoff = now - days * 86400000, seen = new Map();
  let anchor = previous[0] ? String(previous[0].mid) : undefined;
  let calls = 0, stopReason = 'request-cap', error = null;
  const order = (a, b) => a.time - b.time || Number(a.real_seq) - Number(b.real_seq);
  let oldest = previous[0] ? { time: previous[0].ts / 1000, real_seq: previous[0].realSeq } : null;
  // Include-anchor pagination normally repeats one item. A strict progress check
  // and request cap prevent a protocol endpoint from looping on the same page.
  for (let page = 0; page < Math.ceil(count / 99) + 1; page++) {
    if (oldest && oldest.time * 1000 < cutoff) { stopReason = 'time-boundary-already-stored'; break; }
    let data;
    try {
      calls++;
      data = await onebot.call('get_group_msg_history', { group_id: groupId,
        ...(anchor === undefined ? {} : { message_seq: anchor }), count: 100,
        reverse_order: true, parse_mult_msg: false, disable_get_url: true });
    } catch (e) { error = e.message; stopReason = 'api-error'; break; }
    if (!Array.isArray(data.messages)) throw new Error('历史接口缺少messages数组');
    const batch = [...data.messages].sort(order);
    if (!batch.length) { stopReason = 'empty-page'; break; }
    for (const m of batch) {
      if (String(m.group_id) !== groupId || m.message_type !== 'group' || m.message_id == null
        || !Number.isFinite(m.time) || !/^\d+$/.test(String(m.user_id))) throw new Error('历史消息身份或时间字段不符合OneBot契约');
      if (m.time * 1000 >= cutoff && m.time * 1000 <= now) seen.set(String(m.message_id), m);
    }
    if (batch[0].time * 1000 < cutoff) { stopReason = 'time-boundary'; break; }
    if (seen.size >= count) { stopReason = 'message-limit'; break; }
    if (oldest && order(batch[0], oldest) >= 0) { stopReason = 'no-older-progress'; break; }
    oldest = batch[0]; anchor = String(oldest.message_id);
  }
  const selected = [...seen.values()].sort(order).slice(-count);
  const messages = [];
  for (const m of selected) {
    if (blocked.has(String(m.user_id))) continue;
    if (!Array.isArray(m.message)) throw new Error('补拉需要OneBot数组消息格式');
    const text = await segmentsToText(m.message);
    const at = m.message.filter(s => s.type === 'at');
    messages.push({ mid: m.message_id, ts: m.time * 1000, senderId: String(m.user_id),
      senderName: String(m.sender?.card || m.sender?.nickname || m.user_id), text: text || '[图片]',
      self: String(m.user_id) === selfId, read: true, isForward: m.message.some(s => s.type === 'forward'),
      media: extractMediaFromSegments(m.message), atMe: at.some(s => String(s.data.qq) === selfId),
      atNames: at.map(s => `@${s.data.qq}`), source: 'qq-history', realSeq: String(m.real_seq) });
  }
  const merged = new Map(previous.map(m => [String(m.mid), m]));
  for (const m of messages) merged.set(String(m.mid), m);
  const all = [...merged.values()].sort((a, b) => a.ts - b.ts);
  const coverage = { groupId, requestedDays: days, requestedCount: count, fetched: selected.length,
    storedThisRun: messages.length, storedTotal: all.length, calls, stopReason, error,
    firstTs: all[0]?.ts ?? null, lastTs: all.at(-1)?.ts ?? null, pulledAt: now,
    completeQQHistory: false, triggersChat: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ messages: all, coverage }, null, 1), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return coverage;
}
