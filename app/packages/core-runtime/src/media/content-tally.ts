import { sha256 } from '@noble/hashes/sha2.js';
import { Effect, Stream } from 'effect';
import { Hex } from 'effect/encoding';

import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';

/**
 * A running size and SHA-256 over the bytes that pass through one stream. It holds only the hash state and a
 * counter, never the bytes, so a file of any size costs constant memory. One tally belongs to one transfer.
 */
export class ContentTally {
  readonly #hasher = sha256.create();
  #byteSize = 0;

  get byteSize(): number {
    return this.#byteSize;
  }

  add(chunk: Uint8Array): void {
    this.#hasher.update(chunk);
    this.#byteSize += chunk.byteLength;
  }

  /** The size and lowercase hex digest of everything added so far. Call it once, after the last chunk. */
  finish() {
    return {
      byteSize: MediaByteSizeSchema.make(this.#byteSize),
      contentSha256: MediaContentSha256Schema.make(Hex.encode(this.#hasher.digest())),
    };
  }
}

/**
 * Passes every chunk through unchanged while tallying it. `limit` stops the transfer, with `onExceed`, at the
 * first chunk that takes the total past it, so a body longer than declared is not read to its end.
 */
export const tallyStream = <E, ExceedFailure>(
  body: Stream.Stream<Uint8Array, E>,
  tally: ContentTally,
  limit: { readonly byteSize: number; readonly onExceed: () => ExceedFailure } | undefined,
): Stream.Stream<Uint8Array, E | ExceedFailure> =>
  body.pipe(
    // One chunk at a time: the tally is order-dependent, so the sequence is the contract, not an accident.
    Stream.mapEffect(
      (chunk) =>
        Effect.suspend(() => {
          tally.add(chunk);
          return limit !== undefined && tally.byteSize > limit.byteSize
            ? Effect.fail(limit.onExceed())
            : Effect.succeed(chunk);
        }),
      { concurrency: 1 },
    ),
  );
