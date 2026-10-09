import { Crypto, Duration, Effect, Layer, PlatformError } from 'effect';

const WEB_CRYPTO_DIGEST_TIMEOUT = Duration.seconds(5);

const webCryptoFailure = (method: string, cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: 'Unknown',
    cause,
    method,
    module: 'WebCrypto',
  });

/** The host WebCrypto digest is a foreign Promise boundary; a stalled implementation must not hang. */
const webCryptoDigestTimeoutPolicy = Effect.timeoutOrElse({
  duration: WEB_CRYPTO_DIGEST_TIMEOUT,
  orElse: () => Effect.fail(webCryptoFailure('digest', { reason: 'WEB_CRYPTO_DIGEST_TIMEOUT' })),
});

const commercePortalAuthCrypto = Crypto.make({
  digest: (algorithm, data) => {
    const digestInput = new Uint8Array(data.byteLength);
    digestInput.set(data);
    const { subtle } = globalThis.crypto;
    return Effect.tryPromise({
      catch: (cause) => webCryptoFailure('digest', cause),
      try: subtle.digest.bind(subtle, algorithm, digestInput),
    }).pipe(
      webCryptoDigestTimeoutPolicy,
      Effect.map((digest) => new Uint8Array(digest)),
    );
  },
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});

/**
 * Platform cryptography for the optional Commerce deployment; the host supplies WebCrypto. This
 * module owns nothing else: the application root
 * (`verticals/commerce-customer-context/api/index.ts`) imports every provider layer from the
 * module that declares it, so no deployment barrel can drift from its owners.
 */
export const commercePortalAuthPlatformCryptoLive = Layer.succeed(Crypto.Crypto, commercePortalAuthCrypto);
