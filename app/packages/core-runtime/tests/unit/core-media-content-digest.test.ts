import { sha256 } from '@noble/hashes/sha2.js';
import { Effect } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { ContentDigest } from '../../src/media/content-digest.ts';

/*
 * The content digest has two implementations that must agree byte for byte: the pure SHA-256 used on Node and the
 * platform's `crypto.DigestStream` used on a Worker. This suite pins the pure one and drives the native contract
 * (write in order, close, then read `digest`) through a stand-in built on node:crypto; the REAL native stream is
 * proven on workerd in scripts/tests/core-media-download-digest-workerd.test.mts.
 */

const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(70_000).fill(7), new Uint8Array([9])];
const whole = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
const expected = Hex.encode(sha256(whole));

/** What the stand-in recorded about the order of the platform calls. */
const calls: string[] = [];

/* oxlint-disable effect-native/no-promise-shaped-port -- The stand-in mirrors the platform's DigestStream, whose digest is a promise. expires: 2027-03-31. */
/** A native digest stream stand-in: ordered writes, `digest` settles only after `close`. */
class StandInDigestStream {
  readonly digest: Promise<ArrayBuffer>;
  readonly #hash = sha256.create();
  readonly #settle: (digest: ArrayBuffer) => void;

  constructor(algorithm: 'SHA-256') {
    calls.push(`new ${algorithm}`);
    const gate = Promise.withResolvers<ArrayBuffer>();
    this.digest = gate.promise;
    this.#settle = gate.resolve;
  }

  getWriter() {
    return {
      close: () => {
        calls.push('close');
        const bytes = this.#hash.digest();
        this.#settle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return Promise.resolve();
      },
      write: (chunk: Uint8Array) => {
        calls.push(`write ${chunk.byteLength}`);
        this.#hash.update(chunk);
        return Promise.resolve();
      },
    };
  }
}

const run = (digest: ContentDigest) =>
  Effect.gen(function* digestAll() {
    for (const chunk of chunks) {
      yield* digest.add(chunk);
    }
    const first = yield* digest.finish();
    expect(yield* digest.finish()).toEqual(first);
    return first;
  });

it.effect('digests the size and SHA-256 of ordered chunks without keeping them (the default on Node)', () =>
  Effect.gen(function* pure() {
    expect(yield* run(new ContentDigest())).toEqual({ byteSize: whole.byteLength, contentSha256: expected });
  }),
);

it.effect('drives the platform digest stream in order and reads its digest only after close', () =>
  Effect.gen(function* native() {
    calls.length = 0;
    expect(yield* run(new ContentDigest({ digestStream: StandInDigestStream }))).toEqual({
      byteSize: whole.byteLength,
      contentSha256: expected,
    });
    expect(calls).toEqual(['new SHA-256', 'write 3', 'write 0', 'write 70000', 'write 1', 'close']);
  }),
);

it.effect('digests an empty object', () =>
  Effect.gen(function* empty() {
    const digest = new ContentDigest({ digestStream: StandInDigestStream });
    expect(yield* digest.finish()).toEqual({ byteSize: 0, contentSha256: Hex.encode(sha256(new Uint8Array(0))) });
  }),
);
