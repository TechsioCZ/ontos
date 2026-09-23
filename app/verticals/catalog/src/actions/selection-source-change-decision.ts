import { Schema } from 'effect';

const ResolvedSourceLevelSchema = Schema.Literals(['PRODUCT', 'VARIANT', 'ABSENT']);

/**
 * A single resolved Current selection fact is decided by one source level and exact revision.
 * `ABSENT` means the owner proved that no value is resolved at that level.
 */
const ResolvedCurrentSelectionChangeSchema = Schema.Struct({
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the explicit "no value at this level" marker, distinct from an omitted field. expires: 2027-03-31.
  nextRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  nextSourceLevel: ResolvedSourceLevelSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the explicit "no value at this level" marker, distinct from an omitted field. expires: 2027-03-31.
  previousRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  previousSourceLevel: ResolvedSourceLevelSchema,
});

export type ResolvedCurrentSelectionChange = typeof ResolvedCurrentSelectionChangeSchema.Type;

/**
 * A committed source write may announce a confirmed Current change only when the owner can
 * prove the resolved Current fact. `UNPROVEN` is a typed no-emit: the source change is
 * committed, but #479 has not supplied the resolved-Current evidence needed to claim impact.
 */
export type SelectionSourceChangeDecision =
  | { readonly kind: 'CHANGED'; readonly proof: ResolvedCurrentSelectionChange }
  | { readonly kind: 'UNCHANGED'; readonly reason: string }
  | { readonly kind: 'UNPROVEN'; readonly reason: string };

export const decideSelectionSourceChange = (proof?: ResolvedCurrentSelectionChange): SelectionSourceChangeDecision => {
  if (proof === undefined) {
    return { kind: 'UNPROVEN', reason: 'Resolved Current selection change proof is not available' };
  }
  if (proof.previousSourceLevel === proof.nextSourceLevel && proof.previousRevision === proof.nextRevision) {
    return { kind: 'UNCHANGED', reason: 'Resolved Current selection value is unchanged' };
  }
  return { kind: 'CHANGED', proof };
};
