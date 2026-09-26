import { DateTime, Schema } from 'effect';

import type {
  InventorySourceAssertion,
  InventorySourceAssertionProposal,
  InventorySourceOrderingEvidence,
} from './inventory-source-assertion.ts';
import {
  InventorySourceAssertionProposalSchema,
  OwnerOrderKeyEvidenceSchema,
  SourceCoverageEvidenceSchema,
  SourceRevisionOrderingEvidenceSchema,
} from './inventory-source-assertion.ts';

export const InventorySourceOrderRelationSchema = Schema.Literals(['OLDER', 'SAME', 'NEWER', 'INCOMPARABLE']);
export type InventorySourceOrderRelation = typeof InventorySourceOrderRelationSchema.Type;

const compareText = (left: string, right: string): Exclude<InventorySourceOrderRelation, 'INCOMPARABLE'> => {
  if (left === right) {
    return 'SAME';
  }
  return left < right ? 'OLDER' : 'NEWER';
};

/**
 * Compares only ordering evidence supplied by the source owner. Transport arrival and batch order
 * deliberately never participate. Decimal source revisions compare numerically; non-decimal
 * revisions are comparable only for equality. Owner order keys are defined as lexicographically
 * sortable keys by their owner.
 */
export const compareInventorySourceOrdering = (
  left: InventorySourceOrderingEvidence,
  right: InventorySourceOrderingEvidence,
): InventorySourceOrderRelation => {
  if (Schema.is(SourceRevisionOrderingEvidenceSchema)(left)) {
    if (!Schema.is(SourceRevisionOrderingEvidenceSchema)(right)) {
      return 'INCOMPARABLE';
    }
    if (left.revision === right.revision) {
      return 'SAME';
    }
    if (!/^\d+$/u.test(left.revision) || !/^\d+$/u.test(right.revision)) {
      return 'INCOMPARABLE';
    }
    const leftRevision = BigInt(left.revision);
    const rightRevision = BigInt(right.revision);
    if (leftRevision === rightRevision) {
      return 'SAME';
    }
    return leftRevision < rightRevision ? 'OLDER' : 'NEWER';
  }
  if (!Schema.is(OwnerOrderKeyEvidenceSchema)(right)) {
    return 'INCOMPARABLE';
  }
  return compareText(left.key, right.key);
};

type SourceAssertionMaterial = Pick<
  InventorySourceAssertionProposal,
  | 'businessObservedAt'
  | 'coverage'
  | 'customerConfigurationId'
  | 'factMeaning'
  | 'issuer'
  | 'itemExternalKey'
  | 'locationExternalKey'
  | 'orderingEvidence'
  | 'ownerEvidenceRef'
  | 'positionRef'
  | 'quantity'
  | 'sourceReference'
>;

const canonicalCoverage = (coverage: InventorySourceAssertionProposal['coverage']) =>
  coverage
    .map(({ assertionId: _assertionId, ...evidence }) => evidence)
    .toSorted((left, right) => {
      if (left.effectId === right.effectId) {
        return 0;
      }
      return left.effectId < right.effectId ? -1 : 1;
    });

const canonicalOrderingEvidence = (evidence: InventorySourceOrderingEvidence) => {
  if (Schema.is(SourceRevisionOrderingEvidenceSchema)(evidence)) {
    return {
      _tag: 'SOURCE_REVISION' as const,
      value: /^\d+$/u.test(evidence.revision) ? BigInt(evidence.revision).toString() : evidence.revision,
    };
  }
  return { _tag: 'OWNER_ORDER_KEY' as const, value: evidence.key };
};

export const canonicalInventorySourceAssertionMaterial = (assertion: SourceAssertionMaterial) => ({
  businessObservedAt: DateTime.toEpochMillis(DateTime.makeUnsafe(assertion.businessObservedAt)),
  coverage: canonicalCoverage(assertion.coverage),
  customerConfigurationId: assertion.customerConfigurationId,
  factMeaning: assertion.factMeaning,
  issuer: assertion.issuer,
  itemExternalKey: assertion.itemExternalKey,
  locationExternalKey: assertion.locationExternalKey,
  orderingEvidence: canonicalOrderingEvidence(assertion.orderingEvidence),
  ownerEvidenceRef: assertion.ownerEvidenceRef,
  positionRef: assertion.positionRef,
  quantity: assertion.quantity,
  sourceReference: assertion.sourceReference,
});

const SourceAssertionMaterialSchema = Schema.Struct({
  businessObservedAt: Schema.Finite,
  coverage: Schema.Array(
    Schema.Struct({
      effectId: SourceCoverageEvidenceSchema.fields.effectId,
      ownerEvidenceRef: SourceCoverageEvidenceSchema.fields.ownerEvidenceRef,
      relation: SourceCoverageEvidenceSchema.fields.relation,
    }),
  ),
  customerConfigurationId: InventorySourceAssertionProposalSchema.fields.customerConfigurationId,
  factMeaning: InventorySourceAssertionProposalSchema.fields.factMeaning,
  issuer: InventorySourceAssertionProposalSchema.fields.issuer,
  itemExternalKey: InventorySourceAssertionProposalSchema.fields.itemExternalKey,
  locationExternalKey: InventorySourceAssertionProposalSchema.fields.locationExternalKey,
  orderingEvidence: Schema.Union([
    Schema.TaggedStruct('SOURCE_REVISION', { value: Schema.String }),
    Schema.TaggedStruct('OWNER_ORDER_KEY', { value: Schema.String }),
  ]),
  ownerEvidenceRef: InventorySourceAssertionProposalSchema.fields.ownerEvidenceRef,
  positionRef: InventorySourceAssertionProposalSchema.fields.positionRef,
  quantity: InventorySourceAssertionProposalSchema.fields.quantity,
  sourceReference: InventorySourceAssertionProposalSchema.fields.sourceReference,
});
const materialContentEquivalent = Schema.toEquivalence(SourceAssertionMaterialSchema);

/** Equality is over decoded business fields, never a caller-provided or persisted fingerprint. */
export const inventorySourceAssertionsHaveSameMaterialContent = (
  left: SourceAssertionMaterial,
  right: SourceAssertionMaterial,
): boolean =>
  materialContentEquivalent(
    canonicalInventorySourceAssertionMaterial(left),
    canonicalInventorySourceAssertionMaterial(right),
  );

export const inventorySourceAssertionsShareStream = (
  left: InventorySourceAssertionProposal,
  right: InventorySourceAssertion | InventorySourceAssertionProposal,
): boolean =>
  left.positionRef.tenantId === right.positionRef.tenantId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.factMeaning === right.factMeaning &&
  left.issuer.backendKind === right.issuer.backendKind &&
  left.issuer.backendId === right.issuer.backendId &&
  left.positionRef.resourceId === right.positionRef.resourceId;

export const inventorySourceAssertionsClaimSameIdentityOrRevision = (
  left: InventorySourceAssertionProposal,
  right: InventorySourceAssertion | InventorySourceAssertionProposal,
): boolean =>
  left.assertionId === right.assertionId ||
  (inventorySourceAssertionsShareStream(left, right) &&
    (left.sourceReference === right.sourceReference ||
      compareInventorySourceOrdering(left.orderingEvidence, right.orderingEvidence) === 'SAME'));
