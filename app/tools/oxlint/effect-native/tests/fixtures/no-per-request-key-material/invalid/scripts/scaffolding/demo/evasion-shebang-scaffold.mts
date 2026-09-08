#!/usr/bin/env node
// expect-count: 1
// The real generator is `scripts/scaffolding/microvertical-action-boundary/scaffold.mts`.
// If `.mts` is not linted, the rule misses its own primary evidence file.
export const renderVerifier = (appId: string): string => `
import { createLocalJWKSet, jwtVerify } from 'jose';

export const verify = (token: string, cfg: { jwks: unknown }) =>
  jwtVerify(token, createLocalJWKSet(cfg.jwks), { audience: '${appId}' });
`;
