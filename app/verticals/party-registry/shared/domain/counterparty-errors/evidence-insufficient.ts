import { Schema } from 'effect';

export class CounterpartyEvidenceInsufficient extends Schema.TaggedError<CounterpartyEvidenceInsufficient>()(
  'CounterpartyEvidenceInsufficient',
  {
    code: Schema.Literal('counterparty_evidence_insufficient'),
    method: Schema.String,
    reason: Schema.String,
  },
) {}
