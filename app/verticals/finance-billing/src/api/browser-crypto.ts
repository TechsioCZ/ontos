import { Crypto, Effect, PlatformError } from 'effect';

// Browser cryptography is a bounded native adapter; Effect owns its failure channel.
export const browserCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.tryPromise({
      catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'Crypto' }),
      try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, algorithm, new Uint8Array(data)),
    }).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.timeoutOrElse({
        duration: '5 seconds',
        orElse: () => Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'digest', module: 'Crypto' })),
      }),
    ),
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});
