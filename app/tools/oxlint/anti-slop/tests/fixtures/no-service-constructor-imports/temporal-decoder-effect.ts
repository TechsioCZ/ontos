import { DateTime, Effect, Result, Schema } from 'effect';

const OutputSchema = Schema.Struct({ reference: Schema.String });
export const makeDecodedEvidence = (value: string) => {
  Effect.runSync(Effect.sync(() => globalThis.console.log(value)));
  return Result.getOrThrow(Schema.decodeUnknownResult(Schema.toType(OutputSchema))({
    reference: DateTime.formatIso(DateTime.makeUnsafe(value)),
  }));
};
