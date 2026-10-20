import crypto from 'node:crypto';
import { detectImageType } from './image-type.js';

// This local Hermes adapter resolves only the existing xAI OAuth credential pool.
const ENDPOINT = 'http://hermes:8645/v1/images/generations';
export const GROK_IMAGE_MODEL = 'grok-imagine-image';

export function imageRequest(text, atMe) {
  if (!atMe) return null;
  const value = String(text).trim();
  const command = /^\/(?:生图|画图)(?:\s+|[：:])(.+)$/s.exec(value);
  if (command) return command[1].trim();
  const natural = /^(?:请)?(?:(?:帮|给|为)我)?(?:画(?=一[张幅只个]|[张幅只个])|生成(?=一[张幅]))(.+)$/s.exec(value);
  return natural ? natural[1].trim() : null;
}

export async function generateGrokImage(prompt) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: GROK_IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json', aspect_ratio: '1:1', resolution: '1k' }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const error = (await response.text()).slice(0, 500);
    throw new Error(`Grok生图 HTTP ${response.status}：${error}`);
  }
  const result = await response.json();
  const base64 = result.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) throw new Error('Grok生图没有返回请求的b64_json图片');
  const buffer = Buffer.from(base64, 'base64');
  const type = detectImageType(buffer);
  if (!type || buffer.length > 15 * 1024 * 1024) throw new Error('Grok返回的图片格式无效或超过15MiB');
  return { base64, mime: type.mime, bytes: buffer.length };
}

export class GrokImages {
  constructor(sender, generate = generateGrokImage) {
    this.sender = sender;
    this.generate = generate;
    this.pending = new Set();
  }

  async reply(chatKey, prompt, messageId) {
    if (this.pending.has(chatKey)) throw new Error('本会话上一张图仍在生成或发送，请等待完成');
    this.pending.add(chatKey);
    try {
      const image = await this.generate(prompt);
      const segments = [
        { type: 'reply', data: { id: String(messageId) } },
        { type: 'text', data: { text: '画好了' } },
        { type: 'image', data: { file: `base64://${image.base64}` } }
      ];
      return await this.sender.sendMedia(chatKey, segments, {
        label: `[Grok生图] ${prompt.slice(0, 100)}`,
        dedupeKey: crypto.createHash('sha256').update(image.base64).digest('hex')
      });
    } finally {
      this.pending.delete(chatKey);
    }
  }
}
