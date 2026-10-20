import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const tests = ['phoebe-local', 'group-stickers-local', 'sticker-tags-local',
  'style-profiles-local', 'style-options-stickers', 'style-timeout-local',
  'persona-control-local', 'history-source-local', 'grok-images-local'];
for (const name of tests) {
  const result = spawnSync(process.execPath, [`test/${name}.mjs`], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
