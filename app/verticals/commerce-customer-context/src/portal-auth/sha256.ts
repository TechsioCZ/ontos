import { sha256Bytes } from '@app/core-runtime/crypto/sha256';
import { Context, Effect, Layer } from 'effect';
import type { PlatformError } from 'effect';
import { WebCrypto } from 'effect/crypto';

/** Portal proof and replay storage require a bounded, typed outage, unlike Effect's infallible Digest service. */
export class CommerceAuthSha256 extends Context.Service<
  CommerceAuthSha256,
  {
    readonly hash: (value: string) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  }
>()('@app/commerce-customer-context/portal-auth/sha256/CommerceAuthSha256') {}

export const makeCommerceAuthSha256 = (crypto: Pick<typeof globalThis.crypto, 'subtle'>) =>
  CommerceAuthSha256.of({ hash: (value) => sha256Bytes(crypto, new TextEncoder().encode(value), '5 seconds') });

export const commerceAuthSha256Live = Layer.effect(
  CommerceAuthSha256,
  WebCrypto.WebCrypto.pipe(Effect.map(makeCommerceAuthSha256)),
);
