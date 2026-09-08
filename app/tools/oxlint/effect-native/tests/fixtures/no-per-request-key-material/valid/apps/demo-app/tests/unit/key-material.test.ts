// D tier: per-test key generation and fixture key material stay as they are.
import { exportJWK, generateKeyPair, importJWK } from 'jose';

export const fixtureKey = async () => {
  const pair = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(pair.publicKey);
  return await importJWK(jwk, 'EdDSA');
};
