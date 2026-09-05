// expect-count: 2
// EVASION: idiomatic WebCrypto `const { subtle } = crypto` breaks the static `crypto.subtle` chain.
export const a = async (raw: BufferSource) => {
  const { subtle } = globalThis.crypto;
  return await subtle.importKey('raw', raw, 'HMAC', false, ['sign']);
};

export const b = async () => {
  const subtle = crypto.subtle;
  return await subtle.importKey('raw', new Uint8Array(), 'HMAC', false, ['sign']);
};
