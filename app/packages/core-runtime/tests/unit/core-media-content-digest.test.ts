import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, Duration, Effect, Exit, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { ContentDigest, DigestStepTimeout } from '../../src/media/content-digest.ts';

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
/** A write waits for the next gate queued here, when a test wants to control how long one step takes. */
const writeGates: PromiseWithResolvers<undefined>[] = [];
const settled: undefined = globalThis.undefined;

/** A native digest stream stand-in: ordered writes, `digest` settles only after `close`. */
class StandInDigestStream extends WritableStream<Uint8Array> {
  readonly digest;

  constructor(algorithm: 'SHA-256') {
    const gate = Promise.withResolvers<ArrayBuffer>();
    const hash = sha256.create();
    calls.push(`new ${algorithm}`);
    super({
      close: () => {
        calls.push('close');
        const bytes = hash.digest();
        gate.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      write: (chunk) => {
        calls.push(`write ${chunk.byteLength}`);
        hash.update(chunk);
        return writeGates.shift()?.promise;
      },
    });
    this.digest = gate.promise;
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

/*
 * `digestStepTimeout` is a technical guard against a stuck platform call, measured per STEP (one chunk write, or the
 * final close and digest), never over the whole object: an object of any size passes as long as each step answers.
 */

it.effect('keeps the default step guard at five seconds', () =>
  Effect.gen(function* defaultGuard() {
    expect(Duration.toMillis(yield* Effect.service(DigestStepTimeout))).toBe(5000);
  }),
);

it.effect('bounds each step, not the object: many slow steps pass a guard shorter than their sum', () =>
  Effect.gen(function* perStep() {
    const digest = new ContentDigest({ digestStream: StandInDigestStream });
    // Six writes that each take 30 ms of virtual time: 180 ms in all, well past the 100 ms guard, none stopped.
    for (let step = 0; step < 6; step += 1) {
      const gate = Promise.withResolvers<undefined>();
      writeGates.push(gate);
      const added = yield* Effect.forkChild(digest.add(new Uint8Array(4)));
      yield* TestClock.adjust(Duration.millis(30));
      gate.resolve(settled);
      yield* Fiber.join(added);
    }
    expect(digest.byteSize).toBe(24);
  }).pipe(Effect.provideService(DigestStepTimeout, Duration.millis(100))),
);

it.effect('fails a step that does not answer within the configured guard as a retryable unavailability', () =>
  Effect.gen(function* stuck() {
    const digest = new ContentDigest({ digestStream: StandInDigestStream });
    writeGates.push(Promise.withResolvers<undefined>());
    const added = yield* Effect.forkChild(digest.add(new Uint8Array(4)));
    yield* TestClock.adjust(Duration.millis(40));
    const exit = yield* Fiber.await(added);
    expect(Exit.hasDies(exit)).toBe(false);
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code).toBe(
      'media_unavailable',
    );
  }).pipe(Effect.provideService(DigestStepTimeout, Duration.millis(40))),
);
