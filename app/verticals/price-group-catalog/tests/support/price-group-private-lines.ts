import { Effect, Schema, Stream } from 'effect';

export class PriceGroupPrivateFrameTooLarge extends Schema.TaggedError<PriceGroupPrivateFrameTooLarge>()(
  'PriceGroupPrivateFrameTooLarge',
  {},
) {}

export const priceGroupPrivateLines = <E, R>(input: Stream.Stream<Uint8Array, E, R>) => {
  let pending = 0;
  return input.pipe(
    Stream.mapEffect((chunk) =>
      Effect.suspend(() => {
        for (const byte of chunk) {
          pending = byte === 10 ? 0 : pending + 1;
          if (pending > 131_072) {
            return Effect.fail(new PriceGroupPrivateFrameTooLarge());
          }
        }
        return Effect.succeed(chunk);
      }),
    ),
    Stream.decodeText(),
    Stream.splitLines,
  );
};
