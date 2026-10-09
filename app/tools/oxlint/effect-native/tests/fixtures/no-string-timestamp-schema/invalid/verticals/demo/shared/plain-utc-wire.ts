import { Schema } from 'effect';

// The same spelling without a temporal codec is still a hand-rolled string contract.
export const UtcWire = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
);
