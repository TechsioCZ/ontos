import { Schema } from 'effect';

export class CrmReferenceIneligible extends Schema.TaggedError<CrmReferenceIneligible>()('CrmReferenceIneligible', {
  code: Schema.Literal('crm_reference_ineligible'),
  reason: Schema.String,
}) {}
