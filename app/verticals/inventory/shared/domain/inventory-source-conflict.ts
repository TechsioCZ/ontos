import { Effect, Schema } from 'effect';

import {
  InventorySourceAssertionIdSchema,
  InventorySourceAssertionProposalSchema,
  InventorySourceAssertionSchema,
  sourceAssertionBusinessTimeAtOrAfterSelection,
} from './inventory-source-assertion.ts';
import type { InventorySourceAssertionProposal } from './inventory-source-assertion.ts';
import {
  inventorySourceAssertionsClaimSameIdentityOrRevision,
  compareInventorySourceOrdering,
  inventorySourceAssertionsHaveSameMaterialContent,
  inventorySourceAssertionsShareStream,
} from './inventory-source-ordering.ts';
import {
  InventoryBackendConfigurationSchema,
  InventoryBackendSelectionSchema,
} from './inventory-backend-configuration.ts';
import { ExternalStockKeySchema } from './external-stock-correlation.ts';
import { InventorySourceConflictNotFound } from './inventory-source-conflict-not-found.ts';
import { InventorySourceConflictRejected } from './inventory-source-conflict-rejected.ts';
import { InventorySourceConflictUnavailable } from './inventory-source-conflict-unavailable.ts';
import { StockQuantitySchema } from './stock-position.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';
import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const positiveRevision = Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }));

export const InventorySourceConflictTypeSchema = Schema.Literals([
  'CORRELATION',
  'FACT_VALUE',
  'BACKEND_CONFIGURATION',
  'ASSERTION_INTEGRITY',
]);

export const StockPositionFactConflictScopeSchema = Schema.TaggedStruct('STOCK_POSITION_FACT', {
  customerConfigurationId: CustomerConfigurationIdSchema,
  factMeaning: Schema.Literal('ABSOLUTE_PHYSICAL_ON_HAND'),
  positionRef: StockPositionRefSchema,
  unitRef: StockQuantitySchema.fields.unitRef,
});
export const CustomerConfigurationConflictScopeSchema = Schema.TaggedStruct('CUSTOMER_CONFIGURATION', {
  customerConfigurationId: CustomerConfigurationIdSchema,
  tenantId: InventorySourceConflictRefSchema.fields.tenantId,
});
export const ExternalCorrelationConflictScopeSchema = Schema.TaggedStruct('EXTERNAL_CORRELATION', {
  ambiguousExternalKey: ExternalStockKeySchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  tenantId: InventorySourceConflictRefSchema.fields.tenantId,
});
export const InventorySourceConflictScopeSchema = Schema.Union([
  StockPositionFactConflictScopeSchema,
  CustomerConfigurationConflictScopeSchema,
  ExternalCorrelationConflictScopeSchema,
]);

const openCommon = {
  authorityConfiguration: InventoryBackendConfigurationSchema,
  conflictRef: InventorySourceConflictRefSchema,
  currentTruth: Schema.Literal('INDETERMINATE'),
  detectedAt: instant,
  revision: Schema.Literal(1),
  status: Schema.Literal('OPEN'),
} as const;

export const CorrelationConflictEvidenceSchema = Schema.Struct({
  ambiguousExternalKey: ExternalStockKeySchema,
  candidateCorrelationRefs: Schema.Array(ExternalStockCorrelationRefSchema).check(Schema.isMinLength(2)),
  proposal: InventorySourceAssertionProposalSchema,
});

export const OpenCorrelationInventorySourceConflictSchema = Schema.Struct({
  ...openCommon,
  conflictType: Schema.Literal('CORRELATION'),
  evidence: CorrelationConflictEvidenceSchema,
  scope: ExternalCorrelationConflictScopeSchema,
});
export const OpenFactValueInventorySourceConflictSchema = Schema.Struct({
  ...openCommon,
  conflictType: Schema.Literal('FACT_VALUE'),
  evidence: Schema.Array(InventorySourceAssertionProposalSchema).check(Schema.isMinLength(2)),
  scope: StockPositionFactConflictScopeSchema,
});
export const OpenBackendConfigurationInventorySourceConflictSchema = Schema.Struct({
  ...openCommon,
  conflictType: Schema.Literal('BACKEND_CONFIGURATION'),
  currentTruth: Schema.Literal('INDETERMINATE'),
  evidence: Schema.Struct({
    attemptedSelection: InventoryBackendSelectionSchema,
    ownerEvidenceRef: boundedText,
    selectedConfiguration: InventoryBackendConfigurationSchema,
  }),
  scope: CustomerConfigurationConflictScopeSchema,
});
export const OpenAssertionIntegrityInventorySourceConflictSchema = Schema.Struct({
  ...openCommon,
  conflictType: Schema.Literal('ASSERTION_INTEGRITY'),
  evidence: Schema.Tuple([InventorySourceAssertionProposalSchema, InventorySourceAssertionProposalSchema]),
  scope: StockPositionFactConflictScopeSchema,
});
export const InventorySourceConflictOpenSchema = Schema.Union([
  OpenCorrelationInventorySourceConflictSchema,
  OpenFactValueInventorySourceConflictSchema,
  OpenBackendConfigurationInventorySourceConflictSchema,
  OpenAssertionIntegrityInventorySourceConflictSchema,
]);
export type InventorySourceConflictOpen = typeof InventorySourceConflictOpenSchema.Type;

export const CurrentAssertionConflictResolutionInputSchema = Schema.TaggedStruct('CURRENT_ASSERTION', {
  assertionId: InventorySourceAssertionIdSchema,
});
export const BackendConfigurationConflictResolutionInputSchema = Schema.TaggedStruct('BACKEND_CONFIGURATION', {
  configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
});
export const InventorySourceConflictResolutionInputSchema = Schema.Struct({
  conflictRef: InventorySourceConflictRefSchema,
  expectedRevision: positiveRevision,
  ownerEvidenceRef: boundedText,
  resolution: Schema.Union([
    CurrentAssertionConflictResolutionInputSchema,
    BackendConfigurationConflictResolutionInputSchema,
  ]),
  resolvedAt: instant,
});
export type InventorySourceConflictResolutionInput = typeof InventorySourceConflictResolutionInputSchema.Type;

const resolutionCommon = {
  ownerEvidenceRef: boundedText,
  principalId: boundedText,
  resolvedAt: instant,
} as const;
export const CurrentAssertionConflictResolutionSchema = Schema.TaggedStruct('CURRENT_ASSERTION', {
  ...resolutionCommon,
  assertion: InventorySourceAssertionSchema,
});
export const BackendConfigurationConflictResolutionSchema = Schema.TaggedStruct('BACKEND_CONFIGURATION', {
  ...resolutionCommon,
  configuration: InventoryBackendConfigurationSchema,
});
export const InventorySourceConflictResolutionSchema = Schema.Union([
  CurrentAssertionConflictResolutionSchema,
  BackendConfigurationConflictResolutionSchema,
]);

export const InventorySourceConflictResolvedSchema = Schema.Struct({
  authorityConfiguration: InventoryBackendConfigurationSchema,
  conflictRef: InventorySourceConflictRefSchema,
  conflictType: InventorySourceConflictTypeSchema,
  currentTruth: Schema.Literals(['CURRENT', 'CONFIGURATION_SINGULAR']),
  detectedAt: instant,
  originalEvidence: Schema.Union([
    CorrelationConflictEvidenceSchema,
    Schema.Array(InventorySourceAssertionProposalSchema).check(Schema.isMinLength(2)),
    OpenBackendConfigurationInventorySourceConflictSchema.fields.evidence,
    OpenAssertionIntegrityInventorySourceConflictSchema.fields.evidence,
  ]),
  resolution: InventorySourceConflictResolutionSchema,
  revision: Schema.Literal(2),
  scope: InventorySourceConflictScopeSchema,
  status: Schema.Literal('RESOLVED'),
});
export type InventorySourceConflictResolved = typeof InventorySourceConflictResolvedSchema.Type;

export const InventorySourceConflictSchema = Schema.Union([
  InventorySourceConflictOpenSchema,
  InventorySourceConflictResolvedSchema,
]);
export type InventorySourceConflict = typeof InventorySourceConflictSchema.Type;

export const externalStockKeysAreEqual = (
  left: typeof ExternalStockKeySchema.Type,
  right: typeof ExternalStockKeySchema.Type,
) =>
  left.identifierKind === right.identifierKind &&
  left.tenantId === right.tenantId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.externalValue === right.externalValue &&
  left.namespace === right.namespace &&
  left.externalScope === right.externalScope &&
  left.issuer.backendId === right.issuer.backendId &&
  left.issuer.backendKind === right.issuer.backendKind;

const replayProposalsAreEquivalent = (
  left: readonly InventorySourceAssertionProposal[],
  right: readonly InventorySourceAssertionProposal[],
) =>
  left.length === right.length &&
  left.every((proposal) =>
    right.some(
      (candidate) =>
        candidate.assertionId === proposal.assertionId &&
        inventorySourceAssertionsHaveSameMaterialContent(candidate, proposal),
    ),
  );

/** Exact replay ignores transport arrival/detection representation but retains all owner material evidence. */
export const inventorySourceConflictsHaveSameOpenEvidence = (
  left: InventorySourceConflictOpen,
  right: InventorySourceConflictOpen,
): boolean => {
  if (
    left.conflictType !== right.conflictType ||
    !Schema.toEquivalence(InventoryBackendConfigurationSchema)(
      left.authorityConfiguration,
      right.authorityConfiguration,
    ) ||
    !Schema.toEquivalence(InventorySourceConflictScopeSchema)(left.scope, right.scope)
  ) {
    return false;
  }
  if (
    Schema.is(OpenCorrelationInventorySourceConflictSchema)(left) &&
    Schema.is(OpenCorrelationInventorySourceConflictSchema)(right)
  ) {
    const leftRefs = left.evidence.candidateCorrelationRefs
      .map((reference) => `${reference.tenantId}:${reference.resourceId}`)
      .toSorted();
    const rightRefs = right.evidence.candidateCorrelationRefs
      .map((reference) => `${reference.tenantId}:${reference.resourceId}`)
      .toSorted();
    return (
      externalStockKeysAreEqual(left.evidence.ambiguousExternalKey, right.evidence.ambiguousExternalKey) &&
      leftRefs.length === rightRefs.length &&
      leftRefs.every((reference, index) => reference === rightRefs[index]) &&
      left.evidence.proposal.assertionId === right.evidence.proposal.assertionId &&
      inventorySourceAssertionsHaveSameMaterialContent(left.evidence.proposal, right.evidence.proposal)
    );
  }
  if (
    Schema.is(OpenFactValueInventorySourceConflictSchema)(left) &&
    Schema.is(OpenFactValueInventorySourceConflictSchema)(right)
  ) {
    return replayProposalsAreEquivalent(left.evidence, right.evidence);
  }
  if (
    Schema.is(OpenAssertionIntegrityInventorySourceConflictSchema)(left) &&
    Schema.is(OpenAssertionIntegrityInventorySourceConflictSchema)(right)
  ) {
    return replayProposalsAreEquivalent(left.evidence, right.evidence);
  }
  return (
    Schema.is(OpenBackendConfigurationInventorySourceConflictSchema)(left) &&
    Schema.is(OpenBackendConfigurationInventorySourceConflictSchema)(right) &&
    Schema.toEquivalence(OpenBackendConfigurationInventorySourceConflictSchema.fields.evidence)(
      left.evidence,
      right.evidence,
    )
  );
};

export const CorrelationConflictCandidateSchema = Schema.TaggedStruct('CORRELATION', {
  ambiguousExternalKey: ExternalStockKeySchema,
  candidateCorrelationRefs: Schema.Array(ExternalStockCorrelationRefSchema).check(Schema.isMinLength(2)),
  conflictRef: InventorySourceConflictRefSchema,
  detectedAt: instant,
  proposal: InventorySourceAssertionProposalSchema,
  selectedConfiguration: InventoryBackendConfigurationSchema,
});
export const FactValueConflictCandidateSchema = Schema.TaggedStruct('FACT_VALUE', {
  conflictRef: InventorySourceConflictRefSchema,
  detectedAt: instant,
  evidence: Schema.Array(InventorySourceAssertionProposalSchema).check(Schema.isMinLength(2)),
  selectedConfiguration: InventoryBackendConfigurationSchema,
});
export const BackendConfigurationConflictCandidateSchema = Schema.TaggedStruct('BACKEND_CONFIGURATION', {
  attemptedSelection: InventoryBackendSelectionSchema,
  conflictRef: InventorySourceConflictRefSchema,
  detectedAt: instant,
  ownerEvidenceRef: boundedText,
  selectedConfiguration: InventoryBackendConfigurationSchema,
});
export const AssertionIntegrityConflictCandidateSchema = Schema.TaggedStruct('ASSERTION_INTEGRITY', {
  accepted: InventorySourceAssertionProposalSchema,
  conflictRef: InventorySourceConflictRefSchema,
  detectedAt: instant,
  incoming: InventorySourceAssertionProposalSchema,
  selectedConfiguration: InventoryBackendConfigurationSchema,
});
export const InventorySourceConflictCandidateSchema = Schema.Union([
  CorrelationConflictCandidateSchema,
  FactValueConflictCandidateSchema,
  BackendConfigurationConflictCandidateSchema,
  AssertionIntegrityConflictCandidateSchema,
]);
export type InventorySourceConflictCandidate = typeof InventorySourceConflictCandidateSchema.Type;

const sameUnit = (
  left: InventorySourceAssertionProposal['quantity']['unitRef'],
  right: InventorySourceAssertionProposal['quantity']['unitRef'],
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const exactFactScope = (proposal: InventorySourceAssertionProposal) => ({
  _tag: 'STOCK_POSITION_FACT' as const,
  customerConfigurationId: proposal.customerConfigurationId,
  factMeaning: proposal.factMeaning,
  positionRef: proposal.positionRef,
  unitRef: proposal.quantity.unitRef,
});

const candidatesShareExactScope = (evidence: readonly InventorySourceAssertionProposal[]) => {
  const [first, ...rest] = evidence;
  return (
    first !== undefined &&
    rest.every(
      (candidate) =>
        inventorySourceAssertionsShareStream(candidate, first) &&
        sameUnit(candidate.quantity.unitRef, first.quantity.unitRef),
    )
  );
};

const selectedConfigurationAuthorizes = (
  configuration: typeof InventoryBackendConfigurationSchema.Type,
  proposal: InventorySourceAssertionProposal,
) =>
  configuration.tenantId === proposal.positionRef.tenantId &&
  configuration.customerConfigurationId === proposal.customerConfigurationId &&
  configuration.selection.backend === proposal.issuer.backendKind &&
  configuration.selection.backendId === proposal.issuer.backendId &&
  sourceAssertionBusinessTimeAtOrAfterSelection(proposal.businessObservedAt, configuration.selectedAt);

export const InventorySourceConflictErrorSchema = Schema.Union([
  InventorySourceConflictNotFound,
  InventorySourceConflictRejected,
  InventorySourceConflictUnavailable,
]);
export type InventorySourceConflictError = typeof InventorySourceConflictErrorSchema.Type;

const invalidCandidate = (
  candidate: InventorySourceConflictCandidate,
  reason: InventorySourceConflictRejected['reason'],
): InventorySourceConflictRejected =>
  new InventorySourceConflictRejected({
    code: 'inventory_source_conflict_rejected',
    conflictRef: candidate.conflictRef,
    reason,
  });

/** Pure classification retains source owner evidence while transport arrival never selects Current truth. */
/* oxlint-disable eslint/complexity, effect-native/no-manual-tag-comparison -- Classification keeps the four fail-closed schema variants and exact evidence checks together; expires: 2027-03-31. */
export const classifyInventorySourceConflict = (
  candidate: InventorySourceConflictCandidate,
): Effect.Effect<InventorySourceConflictOpen, InventorySourceConflictRejected> => {
  if (candidate._tag === 'FACT_VALUE') {
    const [first] = candidate.evidence;
    if (
      first === undefined ||
      !candidatesShareExactScope(candidate.evidence) ||
      candidate.evidence.some(
        (proposal) => !selectedConfigurationAuthorizes(candidate.selectedConfiguration, proposal),
      ) ||
      candidate.evidence.some((proposal, index) =>
        candidate.evidence
          .slice(index + 1)
          .some(
            (other) =>
              compareInventorySourceOrdering(proposal.orderingEvidence, other.orderingEvidence) !== 'INCOMPARABLE',
          ),
      ) ||
      new Set(candidate.evidence.map(({ quantity }) => quantity.amount)).size < 2
    ) {
      return Effect.fail(invalidCandidate(candidate, 'INVALID_FACT_VALUE_CONFLICT'));
    }
    return Effect.succeed({
      authorityConfiguration: candidate.selectedConfiguration,
      conflictRef: candidate.conflictRef,
      conflictType: 'FACT_VALUE',
      currentTruth: 'INDETERMINATE',
      detectedAt: candidate.detectedAt,
      evidence: candidate.evidence,
      revision: 1,
      scope: exactFactScope(first),
      status: 'OPEN',
    });
  }
  if (candidate._tag === 'ASSERTION_INTEGRITY') {
    if (
      !inventorySourceAssertionsClaimSameIdentityOrRevision(candidate.incoming, candidate.accepted) ||
      inventorySourceAssertionsHaveSameMaterialContent(candidate.incoming, candidate.accepted) ||
      !candidatesShareExactScope([candidate.accepted, candidate.incoming]) ||
      !selectedConfigurationAuthorizes(candidate.selectedConfiguration, candidate.accepted) ||
      !selectedConfigurationAuthorizes(candidate.selectedConfiguration, candidate.incoming)
    ) {
      return Effect.fail(invalidCandidate(candidate, 'INVALID_ASSERTION_INTEGRITY_CONFLICT'));
    }
    return Effect.succeed({
      authorityConfiguration: candidate.selectedConfiguration,
      conflictRef: candidate.conflictRef,
      conflictType: 'ASSERTION_INTEGRITY',
      currentTruth: 'INDETERMINATE',
      detectedAt: candidate.detectedAt,
      evidence: [candidate.accepted, candidate.incoming],
      revision: 1,
      scope: exactFactScope(candidate.accepted),
      status: 'OPEN',
    });
  }
  if (candidate._tag === 'CORRELATION') {
    const exactKey =
      candidate.ambiguousExternalKey.identifierKind === 'ITEM'
        ? candidate.proposal.itemExternalKey
        : candidate.proposal.locationExternalKey;
    const candidateIdentities = candidate.candidateCorrelationRefs.map(
      (reference) => `${reference.tenantId}:${reference.resourceId}`,
    );
    if (
      !externalStockKeysAreEqual(exactKey, candidate.ambiguousExternalKey) ||
      String(candidate.ambiguousExternalKey.tenantId) !== String(candidate.conflictRef.tenantId) ||
      candidate.ambiguousExternalKey.customerConfigurationId !==
        candidate.selectedConfiguration.customerConfigurationId ||
      candidate.candidateCorrelationRefs.some(
        (reference) => String(reference.tenantId) !== String(candidate.conflictRef.tenantId),
      ) ||
      new Set(candidateIdentities).size !== candidateIdentities.length ||
      !selectedConfigurationAuthorizes(candidate.selectedConfiguration, candidate.proposal)
    ) {
      return Effect.fail(invalidCandidate(candidate, 'INVALID_CORRELATION_CONFLICT'));
    }
    return Effect.succeed({
      authorityConfiguration: candidate.selectedConfiguration,
      conflictRef: candidate.conflictRef,
      conflictType: 'CORRELATION',
      currentTruth: 'INDETERMINATE',
      detectedAt: candidate.detectedAt,
      evidence: {
        ambiguousExternalKey: candidate.ambiguousExternalKey,
        candidateCorrelationRefs: candidate.candidateCorrelationRefs,
        proposal: candidate.proposal,
      },
      revision: 1,
      scope: {
        _tag: 'EXTERNAL_CORRELATION',
        ambiguousExternalKey: candidate.ambiguousExternalKey,
        customerConfigurationId: candidate.ambiguousExternalKey.customerConfigurationId,
        tenantId: candidate.conflictRef.tenantId,
      },
      status: 'OPEN',
    });
  }
  const selected = candidate.selectedConfiguration;
  const attempted = candidate.attemptedSelection;
  if (
    String(selected.tenantId) !== String(candidate.conflictRef.tenantId) ||
    selected.selection.backend === attempted.backend ||
    new Set([selected.selection.backend, attempted.backend]).size !== 2
  ) {
    return Effect.fail(invalidCandidate(candidate, 'INVALID_BACKEND_CONFIGURATION_CONFLICT'));
  }
  return Effect.succeed({
    authorityConfiguration: selected,
    conflictRef: candidate.conflictRef,
    conflictType: 'BACKEND_CONFIGURATION',
    currentTruth: 'INDETERMINATE',
    detectedAt: candidate.detectedAt,
    evidence: {
      attemptedSelection: attempted,
      ownerEvidenceRef: candidate.ownerEvidenceRef,
      selectedConfiguration: selected,
    },
    revision: 1,
    scope: {
      _tag: 'CUSTOMER_CONFIGURATION',
      customerConfigurationId: selected.customerConfigurationId,
      tenantId: candidate.conflictRef.tenantId,
    },
    status: 'OPEN',
  });
};
/* oxlint-enable eslint/complexity, effect-native/no-manual-tag-comparison */

export { InventorySourceConflictNotFound } from './inventory-source-conflict-not-found.ts';
export { InventorySourceConflictRejected } from './inventory-source-conflict-rejected.ts';
export { InventorySourceConflictUnavailable } from './inventory-source-conflict-unavailable.ts';
