import { Context, Effect, Layer, PlatformError } from 'effect';
import { WebCrypto } from 'effect/crypto';

/** Portal proof and replay storage require a bounded, typed outage, unlike Effect's infallible Digest service. */
export class CommerceAuthSha256 extends Context.Service<
  CommerceAuthSha256,
  {
    readonly hash: (value: string) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  }
>()('@app/commerce-customer-context/portal-auth/sha256/CommerceAuthSha256') {}

export const commerceAuthDigestUnavailable = (cause: unknown) =>
  PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'WebCrypto' });

const digestTimeout = Effect.timeoutOrElse({
  duration: '5 seconds',
  orElse: () => Effect.fail(commerceAuthDigestUnavailable({ reason: 'WEB_CRYPTO_DIGEST_TIMEOUT' })),
});

/**
 * The host digest arrives as an Effect; the live layer converts the WebCrypto Promise once, at the driver edge.
 * The port bounds every digest it is given, so the proof callers rely on does not depend on the injected host.
 */
export const makeCommerceAuthSha256 = (
  digest: (data: Uint8Array<ArrayBuffer>) => Effect.Effect<ArrayBuffer, PlatformError.PlatformError>,
) =>
  CommerceAuthSha256.of({
    hash: (value) =>
      digest(new TextEncoder().encode(value)).pipe(
        digestTimeout,
        Effect.map((bytes) => new Uint8Array(bytes)),
      ),
  });

export const commerceAuthSha256Live = Layer.effect(
  CommerceAuthSha256,
  WebCrypto.WebCrypto.use((crypto) =>
    Effect.succeed(
      makeCommerceAuthSha256((bytes) =>
        Effect.tryPromise({
          catch: commerceAuthDigestUnavailable,
          // oxlint-disable-next-line typescript/promise-function-async -- Lookup and call the host primitive inside tryPromise so a missing subtle provider is also a typed outage.
          try: () => crypto.subtle.digest('SHA-256', bytes),
        }).pipe(digestTimeout),
      ),
    ),
  ),
);
