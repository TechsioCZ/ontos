import { sha256 } from '@noble/hashes/sha2.js';
import { Context, Duration, Effect, Predicate, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';

import { mediaUnavailable } from './errors.ts';
import type { MediaUnavailable } from './errors.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaByteSize, MediaContentSha256 } from './public-contract.ts';

/*
 * The running size and SHA-256 of the bytes of one download or one verification. On a Worker the digest is the
 * platform's native `crypto.DigestStream`: a hash computed in JavaScript costs CPU the Shell Worker class does
 * not have (measured: a 64 MiB object takes 289 ms wall natively and about 1.4 s in JavaScript, which exhausts a
 * 200 ms CPU budget after roughly 9 MiB). Where no native digest exists (Node) the same digest is computed by the
 * pure `@noble/hashes` hash that upload already uses, so both paths agree byte for byte.
 *
 * The digest holds only the hash state and a counter, never the bytes, so an object of any size costs constant
 * memory. One digest belongs to one transfer and consumes its chunks in order.
 */

interface ContentIdentity {
  readonly byteSize: MediaByteSize;
  readonly contentSha256: MediaContentSha256;
}

/**
 * The runtime's `crypto.DigestStream`: a writable stream whose `digest` settles after it is closed. It runs on local
 * CPU against an in-memory hash state.
 */
export type NativeDigestStreamConstructor = new (algorithm: 'SHA-256') => WritableStream<Uint8Array>;

/**
 * The technical guard against a stuck platform call, applied to ONE digest step: a single chunk write, or the final
 * close and digest read. It is never a bound on the whole object, so it is not a product limit and it caps no object
 * size: a 5 second step at the measured native rate (a 64 MiB object digested in 289 ms on workerd) would take a
 * chunk of well over a gibibyte, and the chunks a transfer passes are the transport's, not the object's. The default
 * mirrors the release identity hashing; a deployment may set another through `CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS`.
 */
export const DigestStepTimeout = Context.Reference<Duration.Duration>(
  '@app/core-runtime/media/content-digest/DigestStepTimeout',
  { defaultValue: () => Duration.seconds(5) },
);

/** A constructor is the only thing the platform offers under the name `DigestStream`. */
const DigestStreamConstructorSchema = Schema.declare((candidate): candidate is NativeDigestStreamConstructor =>
  Predicate.isFunction(candidate),
);
const isDigestStreamConstructor = Schema.is(DigestStreamConstructorSchema);

/** The runtime's own digest stream, when it has one. */
export const platformDigestStream = (): NativeDigestStreamConstructor | undefined => {
  const platformCrypto: unknown = globalThis.crypto;
  if (!Predicate.hasProperty(platformCrypto, 'DigestStream')) {
    return undefined;
  }
  const { DigestStream } = platformCrypto;
  return isDigestStreamConstructor(DigestStream) ? DigestStream : undefined;
};

const ArrayBufferSchema = Schema.instanceOf(ArrayBuffer);

const identityOf = (byteSize: number, digest: Uint8Array): ContentIdentity => ({
  byteSize: MediaByteSizeSchema.make(byteSize),
  contentSha256: MediaContentSha256Schema.make(Hex.encode(digest)),
});

/**
 * A platform step that must not hang: an unanswered one proves nothing about the object, so it fails the request as
 * unavailable (retryable), never as corruption and never as a defect.
 */
const stuckDigestStep = () => Effect.failSync(() => mediaUnavailable('The platform digest did not answer'));

/**
 * The size and SHA-256 of the chunks added to it, in order. `add` is called once per chunk and `finish` after the
 * last one; `finish` is repeatable and always answers the same identity.
 */
export class ContentDigest {
  readonly #native:
    | { readonly stream: WritableStream<Uint8Array>; readonly writer: WritableStreamDefaultWriter<Uint8Array> }
    | undefined;
  readonly #pure = sha256.create();
  #byteSize = 0;
  #identity: ContentIdentity | undefined;

  /** `digestStream` is for tests that stand in for the platform: absent means "use the platform's, if any". */
  constructor(options: { readonly digestStream?: NativeDigestStreamConstructor | undefined } = {}) {
    const DigestStream = 'digestStream' in options ? options.digestStream : platformDigestStream();
    if (DigestStream !== undefined) {
      const stream = new DigestStream('SHA-256');
      this.#native = { stream, writer: stream.getWriter() };
    }
  }

  /** The number of bytes added so far. */
  get byteSize(): number {
    return this.#byteSize;
  }

  add(chunk: Uint8Array): Effect.Effect<void, MediaUnavailable> {
    this.#byteSize += chunk.byteLength;
    const native = this.#native;
    if (native === undefined) {
      return Effect.sync(() => {
        this.#pure.update(chunk);
      });
    }
    return Effect.flatMap(Effect.service(DigestStepTimeout), (guard) =>
      Effect.promise(native.writer.write.bind(native.writer, chunk)).pipe(
        Effect.timeoutOrElse({ duration: guard, orElse: stuckDigestStep }),
      ),
    );
  }

  finish(): Effect.Effect<ContentIdentity, MediaUnavailable> {
    const known = this.#identity;
    if (known !== undefined) {
      return Effect.succeed(known);
    }
    const native = this.#native;
    if (native === undefined) {
      return Effect.sync(() => {
        this.#identity ??= identityOf(this.#byteSize, this.#pure.digest());
        return this.#identity;
      });
    }
    // The digest of the platform stream settles only once it is closed.
    const { stream, writer } = native;
    const digest: unknown = Predicate.hasProperty(stream, 'digest') ? stream.digest : undefined;
    return Effect.flatMap(Effect.service(DigestStepTimeout), (guard) =>
      Effect.promise(writer.close.bind(writer)).pipe(
        Effect.andThen(Effect.promise(Promise.resolve.bind(Promise, digest))),
        Effect.flatMap(Schema.decodeUnknownEffect(ArrayBufferSchema)),
        Effect.map((bytes) => identityOf(this.#byteSize, new Uint8Array(bytes))),
        Effect.tap((identity) =>
          Effect.sync(() => {
            this.#identity = identity;
          }),
        ),
        Effect.orDie,
        Effect.timeoutOrElse({ duration: guard, orElse: stuckDigestStep }),
      ),
    );
  }
}

/**
 * Passes every chunk through unchanged while digesting it. `limit` stops the transfer, with `onExceed`, at the first
 * chunk that takes the total past it, so a body longer than declared is not read to its end.
 */
export const digestStream = <E, ExceedFailure>(
  body: Stream.Stream<Uint8Array, E>,
  digest: ContentDigest,
  limit: { readonly byteSize: number; readonly onExceed: () => ExceedFailure } | undefined,
): Stream.Stream<Uint8Array, E | ExceedFailure | MediaUnavailable> =>
  body.pipe(
    // One chunk at a time: the digest is order-dependent, so the sequence is the contract, not an accident.
    Stream.mapEffect(
      (chunk) =>
        digest
          .add(chunk)
          .pipe(
            Effect.flatMap(() =>
              limit !== undefined && digest.byteSize > limit.byteSize
                ? Effect.fail(limit.onExceed())
                : Effect.succeed(chunk),
            ),
          ),
      { concurrency: 1 },
    ),
  );
