// Local-only collection of protocol-marked group stickers; no QQ favorite mutation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
import { detectImageType } from './image-type.js';
import { stickerTag } from './sticker-tags.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_GROUP = 100;
function groupId(chatKey) {
  return /^group:(\d+)$/.exec(chatKey)?.[1] ?? null;
}
function active(chatKey) {
  const id = groupId(chatKey);
  const cfg = getConfig();
  return cfg.phoebe?.groupStickers?.enabled === true && id !== null
    && cfg.allow.groups.map(String).includes(id);
}

export class GroupStickerPool {
  constructor({ directory = path.join(DATA_DIR, 'group-stickers'), download = safeFetchBinary } = {}) {
    this.directory = directory;
    this.download = download;
    this.cache = new Map();
    this.queues = new Map();
    this.lastUsed = new Map();
  }

  #dir(chatKey) {
    const id = groupId(chatKey);
    if (id === null) throw new Error('群表情只支持群聊');
    return path.join(this.directory, `group_${id}`);
  }

  list(chatKey) {
    if (!active(chatKey)) return [];
    if (!this.cache.has(chatKey)) {
      const file = path.join(this.#dir(chatKey), 'index.json');
      const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      if (!Array.isArray(items)) throw new Error('群表情索引必须是数组');
      this.cache.set(chatKey, items);
    }
    return this.cache.get(chatKey);
  }

  collect({ chatKey, entry, segments, selfId }) {
    if (!active(chatKey) || String(entry.senderId) === String(selfId)) return Promise.resolve({ saved:0 });
    // Confirmed NapCat contract: sub_type=1 is a sticker; sub_type=0 is an ordinary image.
    const images = (segments || []).filter(s => s.type === 'image' && Number(s.data?.sub_type) === 1);
    if (!images.length) return Promise.resolve({ saved:0 });
    const task = async () => {
      let saved = 0;
      const added = [];
      for (const image of images) {
        const data = image.data;
        const items = this.list(chatKey);
        const excludedFile = path.join(this.#dir(chatKey), 'excluded.json');
        const excluded = fs.existsSync(excludedFile) ? JSON.parse(fs.readFileSync(excludedFile, 'utf8')) : [];
        if (data.file && excluded.some(i => i.sourceFile === data.file)) continue;
        if (data.file && items.some(i => i.sourceFile === data.file)) continue;
        if (items.length >= MAX_PER_GROUP) throw new Error('本群表情收藏已达100张上限');
        if (!data.url) throw new Error('表情消息缺少可下载地址');
        const { buffer } = await this.download(String(data.url), MAX_BYTES);
        if (!buffer?.length || buffer.length > MAX_BYTES) throw new Error('群表情大小须在10MB以内');
        const type = detectImageType(buffer);
        if (!type) throw new Error('群表情内容不是支持的图片格式');
        const id = createHash('sha256').update(buffer).digest('hex');
        if (excluded.some(i => i.id === id)) continue;
        if (items.some(i => i.id === id)) continue;
        const dir = this.#dir(chatKey);
        fs.mkdirSync(dir, { recursive:true });
        const file = `${id}${type.ext}`;
        fs.writeFileSync(path.join(dir, file), buffer, { mode:0o600 });
        const item = { id, file, groupId:groupId(chatKey), sourceMessageId:String(entry.mid), senderId:String(entry.senderId), sourceFile:String(data.file || ''), createdAt:Date.now(), bytes:buffer.length };
        const updated = [...items, item];
        const index = path.join(dir, 'index.json');
        fs.writeFileSync(index + '.tmp', JSON.stringify(updated, null, 2), { mode:0o600 });
        fs.renameSync(index + '.tmp', index);
        this.cache.set(chatKey, updated);
        added.push({ ...item, path: path.join(dir, file) });
        saved++;
      }
      return { saved, total:this.list(chatKey).length, items: added };
    };
    // Each event is an independent job. A failed download is logged by the caller;
    // the following event still gets its own attempt, without retrying the failed one.
    const next = (this.queues.get(chatKey) || Promise.resolve()).then(task, task);
    this.queues.set(chatKey, next);
    const clear = () => { if (this.queues.get(chatKey) === next) this.queues.delete(chatKey); };
    next.then(clear, clear);
    return next;
  }

  pick(chatKey, roll = Math.random()) {
    const items = this.list(chatKey);
    if (!items.length) return null;
    const probability = getConfig().phoebe.groupStickers.replyProbability;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('群表情概率必须在0到1之间');
    if (roll >= probability) return null;
    const choices = items.length > 1 ? items.filter(i => i.id !== this.lastUsed.get(chatKey)) : items;
    const item = choices[Math.floor(Math.random() * choices.length)];
    return { ...item, path:path.join(this.#dir(chatKey), item.file) };
  }

  markUsed(chatKey, item) {
    this.lastUsed.set(chatKey, item.id);
  }

  candidates(chatKey, text, weights = null) {
    const words = [...new Set(String(text).match(/[\p{Script=Han}]{2,}|[a-z]+/giu) || [])];
    const items = this.list(chatKey).filter(i => !weights || weights.some(w => w.id === i.id));
    const ranked = items.filter(i => i.id !== this.lastUsed.get(chatKey) || items.length === 1).flatMap(item => {
      const label = stickerTag(item.id);
      if (label?.status !== 'ready') return [];
      const content = label.emotions.join('') + label.description + label.useWhen;
      const score = words.reduce((n, word) => n + [...word].filter(ch => content.includes(ch)).length, 0);
      return [{ ...item, path: path.join(this.#dir(chatKey), item.file), label, score, weight: weights?.find(w => w.id === item.id)?.count || 1 }];
    });
    ranked.sort((a, b) => b.score - a.score || b.weight - a.weight || a.id.localeCompare(b.id));
    const selected = ranked.filter(i => i.score > 0).slice(0, 4);
    const covered = new Set(selected.flatMap(i => i.label.emotions));
    for (const item of ranked) {
      if (selected.length >= 8) break;
      if (!selected.includes(item) && item.label.emotions.some(e => !covered.has(e))) {
        selected.push(item);
        item.label.emotions.forEach(e => covered.add(e));
      }
    }
    for (const item of ranked) {
      if (selected.length >= 8) break;
      if (!selected.includes(item)) selected.push(item);
    }
    return selected;
  }

  pickForStyle(chatKey, weights, roll = Math.random()) {
    const items = this.list(chatKey);
    const choices = weights.map(w => {
      const item = items.find(i => i.id === w.id);
      if (!item || !Number.isInteger(w.count) || w.count < 1) throw new Error('人格表情索引或使用次数无效');
      return { ...item, weight: w.count };
    });
    const eligible = choices.length > 1 ? choices.filter(i => i.id !== this.lastUsed.get(chatKey)) : choices;
    const total = eligible.reduce((n, i) => n + i.weight, 0);
    let draw = roll * total;
    for (const item of eligible) {
      draw -= item.weight;
      if (draw < 0) return { ...item, path: path.join(this.#dir(chatKey), item.file) };
    }
    throw new Error('人格表情抽样范围无效');
  }
}

export const groupStickerPool = new GroupStickerPool();
