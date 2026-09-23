import { Schema } from 'effect';

import { CatalogRevisionInstantSchema } from '../domain/catalog-revision-reference.ts';
import { SetCompositionRevisionSchema } from '../domain/set-composition.ts';

export const SetCompositionMutationPayloadSchema = Schema.Struct({
  effectiveFrom: CatalogRevisionInstantSchema,
  effectiveTo: Schema.optionalKey(CatalogRevisionInstantSchema),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  lifecycleState: Schema.Literals(['DRAFT', 'ACTIVE']),
  revision: SetCompositionRevisionSchema,
});
export type SetCompositionMutationPayload = typeof SetCompositionMutationPayloadSchema.Type;

export const SetCompositionMutationResultSchema = Schema.Struct({
  revision: SetCompositionRevisionSchema.fields.reference,
});

export class SetCompositionActionError extends Schema.TaggedError<SetCompositionActionError>()(
  'SetCompositionActionError',
  {
    code: Schema.Literals([
      'set_composition_invalid',
      'set_composition_not_found',
      'set_composition_stale',
      'set_composition_unavailable',
    ]),
    reason: Schema.String,
  },
) {}
