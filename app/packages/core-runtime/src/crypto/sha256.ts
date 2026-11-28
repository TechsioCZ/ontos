import { Effect, PlatformError, Schema } from 'effect';
import type { Duration } from 'effect';

/** Host rejections can echo the input. Keep only the operation, never the original error or its cause. */
const unsupported = Schema.is(Schema.Struct({ name: Schema.Literal('NotSupportedError') }));
const unavailable = (cause: unknown) =>
  PlatformError.systemError({
    _tag: 'Unknown',
    description: unsupported(cause) ? 'Unsupported algorithm' : 'Digest unavailable',
    method: 'digest',
    module: 'WebCrypto',
  });

/** SHA-256 for boundaries promising a typed outage. The caller owns the time budget. */
export const sha256Bytes = (
  crypto: Pick<typeof globalThis.crypto, 'subtle'>,
  bytes: Uint8Array<ArrayBuffer>,
  duration: Duration.Input,
) =>
  Effect.try({
    catch: unavailable,
    try: () => crypto.subtle.digest.bind(crypto.subtle, 'SHA-256', bytes),
  }).pipe(
    Effect.flatMap((digest) => Effect.tryPromise({ catch: unavailable, try: digest })),
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'digest', module: 'WebCrypto' })),
    }),
    Effect.map((result) => new Uint8Array(result)),
  );
