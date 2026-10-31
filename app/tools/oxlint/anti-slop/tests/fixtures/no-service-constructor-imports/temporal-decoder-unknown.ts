import { Result, Schema } from 'effect';

const OutputSchema = Schema.Struct({ dependency: Schema.Unknown });
export const makeDecodedEvidence = () => Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.toType(OutputSchema))({ dependency: () => 'executable' }),
);
