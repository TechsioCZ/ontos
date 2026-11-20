import { sha256 } from '@noble/hashes/sha2.js';
import { Effect, Predicate, Schema } from 'effect';
import { Hex } from 'effect/encoding';

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

// @effect-diagnostics asyncFunction:off -- The platform DigestStream is promise based and must be awaited in order; expires: 2027-03-31.
/* oxlint-disable effect-native/no-promise-shaped-port, effect-native/require-timeout-on-external-effect -- The Workers runtime's DigestStream is a platform type whose writes and digest are promises; they run on local CPU against an in-memory hash, never on an external service, so no timeout or retry policy applies and none may be invented. expires: 2027-03-31. */

/** The writable stream the Workers runtime offers for hashing; its `digest` settles after `close`. */
interface NativeDigestWriter {
  readonly close: () => Promise<void>;
  readonly write: (chunk: Uint8Array) => Promise<void>;
}
interface NativeDigestStream {
  readonly digest: Promise<ArrayBuffer>;
  readonly getWriter: () => NativeDigestWriter;
}
export type NativeDigestStreamConstructor = new (algorithm: 'SHA-256') => NativeDigestStream;

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

const identityOf = (byteSize: number, digest: Uint8Array): ContentIdentity => ({
  byteSize: MediaByteSizeSchema.make(byteSize),
  contentSha256: MediaContentSha256Schema.make(Hex.encode(digest)),
});

/**
 * The size and SHA-256 of the chunks added to it, in order. `add` is called once per chunk and `finish` after the
 * last one; `finish` is repeatable and always answers the same identity.
 */
export class ContentDigest {
  readonly #native: { readonly stream: NativeDigestStream; readonly writer: NativeDigestWriter } | undefined;
  readonly #pure = sha256.create();
  #byteSize = 0;
  #finished: Promise<ContentIdentity> | undefined;

  /** `digestStream` is for tests that stand in for the platform: absent means "use the platform's, if any". */
  constructor(options: { readonly digestStream?: NativeDigestStreamConstructor | undefined } = {}) {
    const DigestStream = 'digestStream' in options ? options.digestStream : platformDigestStream();
    if (DigestStream !== undefined) {
      const stream = new DigestStream('SHA-256');
      this.#native = { stream, writer: stream.getWriter() };
    }
  }

  add(chunk: Uint8Array): Effect.Effect<void> {
    return Effect.promise(async () => {
      this.#byteSize += chunk.byteLength;
      if (this.#native === undefined) {
        this.#pure.update(chunk);
        return;
      }
      await this.#native.writer.write(chunk);
    });
  }

  finish(): Effect.Effect<ContentIdentity> {
    return Effect.promise(async () => {
      this.#finished ??= this.#settle();
      return await this.#finished;
    });
  }

  async #settle(): Promise<ContentIdentity> {
    if (this.#native === undefined) {
      return identityOf(this.#byteSize, this.#pure.digest());
    }
    await this.#native.writer.close();
    return identityOf(this.#byteSize, new Uint8Array(await this.#native.stream.digest));
  }
}
