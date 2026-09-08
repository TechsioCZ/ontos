// Per-request verification/signing entry points are not the anti-pattern: only key material is.
import { jwtVerify, SignJWT, decodeProtectedHeader } from 'jose';
import type { JWK } from 'jose';
import { importJWK } from 'jose';

export const verify = async (token: string, key: unknown) => {
  decodeProtectedHeader(token);
  await jwtVerify(token, key as never);
  return await new SignJWT({}).setProtectedHeader({ alg: 'EdDSA' }).sign(key as never);
};

// A local shadow is not the `jose` binding.
export const shadowed = (jwk: JWK) => {
  const importJWK = (value: JWK): JWK => value;
  return importJWK(jwk);
};

// A non-WebCrypto `subtle` namespace must not match the `crypto.subtle` chain.
export const unrelated = (keyring: { readonly subtle: { readonly importKey: (value: string) => string } }) =>
  keyring.subtle.importKey('raw');

// Type-only imports are not references.
export type Material = JWK;

export const unusedRebuild = importJWK;
