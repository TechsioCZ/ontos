// expect-count: 1
// `Layer.succeed` hands over an ALREADY built value, so a method on it still runs per request: the
// one-hop "handed to a Layer builder" clearance must not apply to `Layer.succeed`.
import { Layer } from 'effect';
import { createLocalJWKSet, jwtVerify } from 'jose';

declare const Tag: never;
declare const configuration: { readonly jwks: unknown };

export const verifyToken = (token: string) =>
  jwtVerify(token, createLocalJWKSet(configuration.jwks as never));

export const ActionJwksLive = Layer.succeed(Tag, { verify: verifyToken });
