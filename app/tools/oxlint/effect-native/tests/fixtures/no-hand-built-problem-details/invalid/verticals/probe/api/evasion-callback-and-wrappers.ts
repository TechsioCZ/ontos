// expect-count: 3
// A literal returned from a callback handed to a Schema combinator, and literals wrapped in
// `Object.freeze` / an array argument, are still hand-built payloads.
import { Effect, Schema } from 'effect';

export const decoded = Schema.transform(Schema.String, {
  decode: () => ({
    _tag: 'ProbeInternalProblem',
    detail: 'The probe operation failed.',
    status: 500,
    title: 'Probe failed',
  }),
  encode: () => '',
});

export const frozen = Object.freeze({
  _tag: 'ProbeConflictProblem',
  detail: 'The probe operation conflicts with the current state.',
  status: 409,
  title: 'Probe conflict',
});

export const failed = Effect.fail([
  {
    _tag: 'ProbeUnavailableProblem',
    detail: 'The probe operation is temporarily unavailable.',
    status: 503,
    title: 'Probe unavailable',
  },
]);
