import { webcrypto } from './ports.ts';
import { exportJWK } from 'jose';
export const injectedImport = (raw: unknown) => webcrypto.subtle.importKey(raw);
export const shadowedGlobal = (globalThis: { crypto: Crypto }, raw: BufferSource) =>
  globalThis.crypto.subtle.importKey('raw', raw, 'HMAC', false, ['sign']);
export const customRequire = (require: (module: string) => { importJWK(): unknown }) => {
  const jose = require('jose');
  return jose.importJWK();
};
export const exportEphemeral = async (key: CryptoKey) => exportJWK(key);
