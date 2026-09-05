// An injected port is not a proven global; ephemeral generation must not be hoisted.
declare const env: { readonly runtime: { readonly crypto: Crypto } };

export const a = async (raw: BufferSource) =>
  await env.runtime.crypto.subtle.importKey('raw', raw, 'HMAC', false, ['sign']);

export const b = async () => await globalThis?.crypto?.subtle?.generateKey?.({ name: 'HMAC' }, true, ['sign']);
