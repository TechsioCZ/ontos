// expect-count: 1
// Pathological: template match sits at offset 0 of the quasi.
export const render = (): string => `createLocalJWKSet(config.jwks)`;
