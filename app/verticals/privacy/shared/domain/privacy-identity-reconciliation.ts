import { Schema } from 'effect';

import { IdentityReconciliationRefSchema } from '../resources/identity-reconciliation.ts';
import { PrivacyPartyRefSchema } from './party-reference.ts';
import type { PrivacyPartyRef } from './party-reference.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const BoundedText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

const PrivacyIdentityChangeKindSchema = Schema.Literals([
  'PARTY_CORRECTION',
  'PARTY_ALIAS',
  'PARTY_MERGE',
  'COMMERCE_PROFILE_RECONCILIATION',
]);

/** Owner evidence for a Party identity change. It is a resolution input, never a new identity key. */
export const PrivacyIdentityChangeSchema = Schema.Struct({
  canonicalPartyRef: PrivacyPartyRefSchema,
  changedAt: PrivacyIsoTimestampSchema,
  evidenceRefs: Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  kind: PrivacyIdentityChangeKindSchema,
  sourceEventRef: BoundedText,
  sourcePartyRef: PrivacyPartyRefSchema,
}).check(
  Schema.makeFilter(({ canonicalPartyRef, sourcePartyRef }) =>
    sourcePartyRef.tenantId === canonicalPartyRef.tenantId
      ? undefined
      : [{ issue: 'identity change Parties must share one tenant', path: ['canonicalPartyRef'] }],
  ),
);
export type PrivacyIdentityChange = typeof PrivacyIdentityChangeSchema.Type;

const PrivacyAffectedFactKindSchema = Schema.Literals([
  'CONSENT_DECISION',
  'REPRESENTATION',
  'RESPONSIBILITY_ASSIGNMENT',
  'PERMISSION',
  'DSR_AUTHORITY',
]);

/** Keeps the original owner reference and provenance explainable after canonical resolution. */
export const PrivacyAffectedFactSchema = Schema.Struct({
  factKind: PrivacyAffectedFactKindSchema,
  factRef: BoundedText,
  originalPartyRef: PrivacyPartyRefSchema,
  provenanceRefs: Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  sourceDecisionRevision: BoundedText,
});
export type PrivacyAffectedFact = typeof PrivacyAffectedFactSchema.Type;

const PrivacyIdentityReconciliationOutcomeSchema = Schema.Literals([
  'NO_TRANSFER_REQUIRED',
  'RECONCILIATION_REQUIRED',
  'RECONCILED',
]);
export type PrivacyIdentityReconciliationOutcome = typeof PrivacyIdentityReconciliationOutcomeSchema.Type;

export const PrivacyIdentityReconciliationSchema = Schema.Struct({
  affectedFacts: Schema.Array(PrivacyAffectedFactSchema).check(Schema.isMaxLength(100)),
  identityChange: PrivacyIdentityChangeSchema,
  outcome: PrivacyIdentityReconciliationOutcomeSchema,
  reconciliationRef: IdentityReconciliationRefSchema,
  requiredOwnerChecks: Schema.Array(BoundedText).check(Schema.isMaxLength(32)),
});

/** Identity changes never transfer privacy authority. Facts require an explicit owner decision. */
export const classifyPrivacyIdentityChange = (
  _identityChange: PrivacyIdentityChange,
  affectedFacts: readonly PrivacyAffectedFact[],
): PrivacyIdentityReconciliationOutcome =>
  affectedFacts.length === 0 ? 'NO_TRANSFER_REQUIRED' : 'RECONCILIATION_REQUIRED';

/** Canonical addressability may follow Party Registry, while historical facts retain their source reference. */
export interface PrivacyAddressabilityResolution {
  readonly canonicalPartyRef: PrivacyPartyRef;
  readonly originalPartyRef: PrivacyPartyRef;
}

export const resolvePrivacyAddressability = (
  identityChange: PrivacyIdentityChange,
  fact: PrivacyAffectedFact,
): PrivacyAddressabilityResolution => ({
  canonicalPartyRef: identityChange.canonicalPartyRef,
  originalPartyRef: fact.originalPartyRef,
});
