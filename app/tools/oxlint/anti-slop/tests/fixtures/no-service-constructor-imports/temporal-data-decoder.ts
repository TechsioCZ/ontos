import { DateTime, Option, Result, Schema, SchemaGetter } from 'effect';

const TimestampSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value ? undefined : 'invalid instant';
  })),
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
const InputSchema = Schema.Struct({
  stamp: TimestampSchema,
  note: Schema.OptionFromNullOr(Schema.String),
}).check(Schema.makeFilter((input) => Option.contains(input.note, 'CZ') ? undefined : 'unsupported code'));
type Input = typeof InputSchema.Type;
const OutputSchema = Schema.Struct({
  stamp: TimestampSchema,
  note: Schema.OptionFromNullOr(Schema.String),
  reference: Schema.String,
});

export const makeDecodedEvidence = (input: Input): typeof OutputSchema.Type =>
  Result.getOrThrow(Schema.decodeUnknownResult(Schema.toType(OutputSchema))({
    ...input,
    reference: DateTime.formatIso(input.stamp),
  }));
