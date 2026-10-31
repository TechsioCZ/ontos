import { Effect, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { PriceGroupPrivateFrameTooLarge, priceGroupPrivateLines } from '../support/price-group-private-lines.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const lines = (chunks: readonly Uint8Array[]) =>
  Stream.fromIterable(chunks).pipe(priceGroupPrivateLines, Stream.runCollect);

it.effect('accepts multiple bounded commands whose combined size exceeds the frame limit', () =>
  Effect.gen(function* multipleFrames() {
    const first = 'a'.repeat(100_000);
    const second = 'b'.repeat(100_000);
    expect(yield* lines([encode(`${first}\n${second}\n`)])).toEqual([first, second]);
  }),
);

it.effect('accepts the exact byte limit and resets it across chunk boundaries after a newline', () =>
  Effect.gen(function* boundaryFrames() {
    const frame = 'a'.repeat(131_072);
    expect(yield* lines([encode(frame), encode('\na'), encode('\n')])).toEqual([frame, 'a']);
  }),
);

it.effect('rejects a single oversized command before decoding it', () =>
  Effect.gen(function* oversizedFrame() {
    const failure = yield* lines([encode(`${'a'.repeat(131_073)}\n`)]).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(PriceGroupPrivateFrameTooLarge);
  }),
);

it.effect('does not reset the frame limit at a transport chunk boundary', () =>
  Effect.gen(function* splitOversizedFrame() {
    const failure = yield* lines([encode('a'.repeat(100_000)), encode('a'.repeat(31_073))]).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(PriceGroupPrivateFrameTooLarge);
  }),
);

it.effect('counts UTF-8 bytes rather than decoded characters', () =>
  Effect.gen(function* multibyteFrame() {
    const failure = yield* lines([encode(`${'é'.repeat(65_537)}\n`)]).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(PriceGroupPrivateFrameTooLarge);
  }),
);
