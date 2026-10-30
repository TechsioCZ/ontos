import { Result, Schema } from 'effect';

const DateTime = { formatIso: (value: string) => globalThis.console.log(value) };
const OutputSchema = Schema.Struct({ reference: Schema.String });
export const makeDecodedEvidence = (value: string) => Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.toType(OutputSchema))({ reference: DateTime.formatIso(value) }),
);
