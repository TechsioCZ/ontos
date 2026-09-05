// expect-count: 3
// EVASION: the CommonJS / dynamic spellings of the same import.
export const viaRequire = (jwks: unknown) => {
  const jose = require('jose');
  return jose.createLocalJWKSet(jwks);
};

export const viaRequireDestructure = (pem: string) => {
  const { createPrivateKey } = require('node:crypto');
  return createPrivateKey(pem);
};

export const viaDynamicImport = async (jwk: unknown) => {
  const { importJWK } = await import('jose');
  return await importJWK(jwk as never, 'EdDSA');
};
