// expect-count: 4
// Alias / submodule-namespace / barrel-glob / optional-chain / cast reachability.
import { Config as Cfg } from 'effect';
import * as S from 'effect/Schema';
import { Schema as BffSchema } from '@modern-js/plugin-bff/effect-edge/runtime';

export const CredentialSchema = S.Struct({
  apiKey: S.String as unknown as typeof S.String,
  password: S?.String,
  secret: S['String'],
});

export const GatewaySchema = BffSchema.Struct({
  clientSecret: BffSchema.NonEmptyString,
  issuer: BffSchema.String,
});

// Already redacted: must stay silent.
export const AuthSecret = Cfg.redacted('BETTER_AUTH_SECRET');
