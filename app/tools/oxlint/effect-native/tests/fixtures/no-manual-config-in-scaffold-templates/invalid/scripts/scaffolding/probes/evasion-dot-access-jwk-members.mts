/** Hand-walked JWK members through dot access instead of `Schema.fromJsonString` (A3). */
export const renderVerifier = (appId: string): string => `
const selectSigningKey = (key: JsonWebKey) =>
  key.kty === 'OKP' && key.crv === 'Ed25519' && key.alg === 'EdDSA' && key.use === 'sig'
    ? { kid: key.kid, x: key.x }
    : undefined;
export const audience = '${appId}';
`;
