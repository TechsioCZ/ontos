import { Schema } from 'effect';

export class AssortmentDecisionRequestInvalidError extends Schema.TaggedError<AssortmentDecisionRequestInvalidError>()(
  'AssortmentDecisionRequestInvalidError',
  {
    code: Schema.Literal('INVALID_DECISION_REQUEST'),
    reason: Schema.Literals(['INVALID_INPUT', 'TRUSTED_SCOPE_MISMATCH']),
  },
) {}
