import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../src/config.js';
import { stickerTag, tagStickers } from '../src/sticker-tags.js';
const limit = Number(process.argv[2] || 4);
if (!Number.isInteger(limit) || limit < 1 || limit > 300) throw new Error('须指定1至300张的本轮上限');
const found = new Map();
for (const group of getConfig().allow.groups) {
  const dir = path.join(DATA_DIR, 'group-stickers', `group_${group}`), index = path.join(dir, 'index.json');
  if (!fs.existsSync(index)) continue;
  for (const item of JSON.parse(fs.readFileSync(index, 'utf8'))) if (!stickerTag(item.id)) found.set(item.id, { ...item, path: path.join(dir, item.file) });
}
const pending = [...found.values()].slice(0, limit);
console.log(JSON.stringify({ unlabeled: found.size, selected: pending.length, batchSize: 4 }));
for (let i = 0; i < pending.length; i += 4) {
  const result = await tagStickers(pending.slice(i, i + 4));
  console.log(JSON.stringify({ done: i + result.items.length, usage: result.usage, details: result.details, items: result.items }));
}
