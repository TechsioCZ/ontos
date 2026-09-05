// expect-count: 2
import { webcrypto as wc } from 'node:crypto';
export const a = async (raw: BufferSource) =>
  await wc.subtle.importKey('raw', raw, 'HMAC', false, ['sign']);
export const b = async (raw: BufferSource) =>
  await globalThis?.crypto?.subtle?.importKey?.('raw', raw, 'HMAC', false, ['sign']);
