import { Schema } from 'effect';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());

export class StorefrontApplicationEvidenceStale extends Schema.TaggedError<StorefrontApplicationEvidenceStale>()(
  'StorefrontApplicationEvidenceStale',
  {
    code: Schema.Literal('storefront_application_evidence_stale'),
    reason,
  },
) {}
