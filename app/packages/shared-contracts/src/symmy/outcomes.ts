import { OntosModuleIdSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { SymmyEffectIdSchema } from './identity.ts';

const acceptedStatus = Schema.Literals(['accepted_change', 'accepted_no_change']);
const isAcceptedStatus = Schema.is(acceptedStatus);

const acceptedEffect = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  owner: OntosModuleIdSchema,
  status: acceptedStatus,
});

// A duplicate represents replay of a verified accepted receipt. Rejections and uncertainty retain their original status.
const duplicateEffect = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  originalStatus: acceptedStatus,
  owner: OntosModuleIdSchema,
  status: Schema.Literal('duplicate'),
});

const rejectedEffect = Schema.Struct({
  effectId: Schema.optionalKey(SymmyEffectIdSchema),
  owner: OntosModuleIdSchema,
  status: Schema.Literals(['stale', 'unresolved', 'ambiguous', 'denied', 'conflict', 'unavailable', 'invalid']),
});

const unsupportedEffect = Schema.Struct({
  branchId: Schema.optionalKey(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyUnsupportedBranchId'))),
  branchKind: Schema.optionalKey(Schema.Literals(['CategoryHint', 'AttributeHint', 'MediaHint', 'VariantUpdateHint'])),
  owner: OntosModuleIdSchema,
  reason: Schema.Literals(['missing_context', 'unsupported_meaning', 'owner_not_activated']),
  status: Schema.Literal('unsupported'),
});

const indeterminateEffect = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  owner: OntosModuleIdSchema,
  status: Schema.Literal('indeterminate'),
});

const progressingEffect = Schema.Struct({
  effectId: SymmyEffectIdSchema,
  owner: OntosModuleIdSchema,
  status: Schema.Literals(['waiting', 'executing']),
});

/** Safe outcomes contain opaque integration IDs and fixed codes, never owner-private values or source records. */
export const SymmyEffectOutcomeSchema = Schema.Union([
  acceptedEffect,
  duplicateEffect,
  rejectedEffect,
  unsupportedEffect,
  indeterminateEffect,
  progressingEffect,
]);

export const SymmyItemOutcomeSchema = Schema.Struct({
  effects: Schema.NonEmptyArray(SymmyEffectOutcomeSchema),
  itemId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyItemId')),
});
export type SymmyItemOutcome = typeof SymmyItemOutcomeSchema.Type;

export const decodeSymmyItemOutcome = Schema.decodeUnknownEffect(SymmyItemOutcomeSchema, {
  onExcessProperty: 'error',
});

export const summarizeSymmyItemOutcome = (item: SymmyItemOutcome): 'accepted' | 'partial' | 'not_accepted' => {
  const acceptedCount = item.effects.filter(
    (effect) => effect.status === 'duplicate' || isAcceptedStatus(effect.status),
  ).length;
  if (acceptedCount === item.effects.length) {
    return 'accepted';
  }
  return acceptedCount > 0 ? 'partial' : 'not_accepted';
};
