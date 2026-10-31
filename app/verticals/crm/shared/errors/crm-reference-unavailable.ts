import { Schema } from 'effect';

export class CrmReferenceUnavailable extends Schema.TaggedError<CrmReferenceUnavailable>()('CrmReferenceUnavailable', {
  code: Schema.Literal('crm_reference_unavailable'),
  reason: Schema.String,
}) {}
