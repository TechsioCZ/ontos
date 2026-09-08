import { Schema } from 'effect';

export class PartyCreateRecoveryUnavailable extends Schema.TaggedError<PartyCreateRecoveryUnavailable>()(
  'PartyCreateRecoveryUnavailable',
  {
    reason: Schema.String,
  }
) {}
