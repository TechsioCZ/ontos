// expect-count: 1
// EVASION: destructuring the member out of a namespace import inside a per-request function.
import * as jose from 'jose';

export const verify = async (jwks: unknown) => {
  const { createLocalJWKSet } = jose;
  return createLocalJWKSet(jwks as never);
};
