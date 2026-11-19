import { Schema } from 'effect';
import { TemplateRevisionIdSchema } from './template-revision.ts';

const refusedFields = {
  code: Schema.Literals([
    'template_content_malformed',
    'template_placeholder_missing',
    'template_placeholder_undeclared',
    'template_scope_mismatch',
    'template_type_declaration_conflict',
    'template_revision_already_active',
    'template_revision_not_active',
    'template_revision_invalidated',
    'template_revision_already_invalidated',
  ]),
  placeholders: Schema.optionalKey(Schema.Array(Schema.String)),
  reason: Schema.String,
};
const refusedContract = Schema.TaggedStruct('TemplateRefused', refusedFields);
/** A business refusal: nothing was changed. */
export const TemplateRefused = Schema.TaggedError<typeof refusedContract.Type>()('TemplateRefused', refusedFields);

const notFoundFields = { code: Schema.Literal('template_revision_not_found'), reason: Schema.String };
const notFoundContract = Schema.TaggedStruct('TemplateRevisionNotFound', notFoundFields);
export const TemplateRevisionNotFound = Schema.TaggedError<typeof notFoundContract.Type>()(
  'TemplateRevisionNotFound',
  notFoundFields,
);

const unavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('template_store_unavailable'),
  reason: Schema.String,
};
const unavailableContract = Schema.TaggedStruct('TemplateStoreUnavailable', unavailableFields);
export const TemplateStoreUnavailable = Schema.TaggedError<typeof unavailableContract.Type>()(
  'TemplateStoreUnavailable',
  unavailableFields,
);

/** Resolution found no unambiguous active revision: an explicit failure, never a guess and never another scope. */
const resolutionFields = {
  code: Schema.Literals(['template_no_active_revision', 'template_active_revision_ambiguous']),
  reason: Schema.String,
};
const resolutionContract = Schema.TaggedStruct('TemplateResolutionFailed', resolutionFields);
export const TemplateResolutionFailed = Schema.TaggedError<typeof resolutionContract.Type>()(
  'TemplateResolutionFailed',
  resolutionFields,
);

/** The pinned revision may not be handed off now. Never carries a replacement: nothing is silently switched. */
const pinBlockedFields = {
  code: Schema.Literals(['pinned_template_revision_unavailable', 'pinned_template_revision_invalidated_unsafe']),
  reason: Schema.String,
  revisionId: TemplateRevisionIdSchema,
};
const pinBlockedContract = Schema.TaggedStruct('TemplatePinBlocked', pinBlockedFields);
export const TemplatePinBlocked = Schema.TaggedError<typeof pinBlockedContract.Type>()(
  'TemplatePinBlocked',
  pinBlockedFields,
);
