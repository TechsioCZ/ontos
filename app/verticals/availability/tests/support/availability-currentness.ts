import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';
import { AvailabilityStockInputSchema } from '../../shared/domain/availability-source-authority.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import { configuration, position, stockInput, subject } from './availability-decision.ts';

const predicateRef = 'owner-predicate-1';
const changedAt = '2026-10-05T12:05:00.000Z';
const boundary = {
  kind: 'INFORMATIONAL' as const,
  requiredAt: subject.purchasingContext.contextVerification.request.operationTime,
};
const complete = {
  _tag: 'COMPLETE' as const,
  evidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: '2026-10-05T12:00:00.000Z',
    ownerRevision: 'set-revision-1',
    scope: { kind: 'EXACT_PREDICATE', predicateRef },
  }),
  predicateRef,
};
export const makeCurrentnessInput = (amounts: readonly string[], requested = '10'): AvailabilityEvaluationInput => {
  const exactSubject = { ...subject, quantity: { ...subject.quantity, amount: requested } };
  const stock = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
    ...stockInput,
    positions: amounts.map((amount, index) => {
      const onHand = {
        ...position.position.onHand,
        _tag: 'CURRENT' as const,
        evidenceRef: `proof-${index}`,
        observedAt: subject.purchasingContext.contextVerification.request.operationTime,
        quantity: { amount, unitRef: subject.quantity.unitRef },
      };
      return {
        ...position,
        position: {
          ...position.position,
          onHand,
          ref: { ...position.position.ref, resourceId: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}` },
        },
        sourceEvidence: { ...position.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
      };
    }),
  });
  return {
    ownerQualification: {
      currentness: 'CURRENT',
      positions: stock.positions.map((entry, index) => ({
        constraintSupport: 'RESOLVED',
        positionRef: entry.position.ref,
        reusableQuantity: {
          _tag: 'PROVEN',
          quantity: { amount: amounts[index] ?? '0', unitRef: subject.quantity.unitRef },
        },
        usability: 'USABLE',
      })),
      selectedBackendAuthority: { _tag: 'PROVEN', configuration },
      set: complete,
      stockInput: stock,
      subject: exactSubject,
      useBoundary: boundary,
    },
    policy: {
      kind: 'LAUNCH_EXACT_QUANTITY',
      owner: 'AVAILABILITY',
      revisionRef: 'LAUNCH_EXACT_QUANTITY_V1',
      subject: exactSubject,
      useBoundary: boundary,
    },
    stockInput: stock,
    subject: exactSubject,
    useBoundary: boundary,
  };
};

const inventoryRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType,
  tenantId: subject.selection.productRef.tenantId,
});

/** Controlled public Inventory contract values, never imported owner fixtures or private persistence. */
export const makeRichExternalCurrentnessInput = (): AvailabilityEvaluationInput => {
  const base = makeCurrentnessInput(['3'], '2');
  const authority = Schema.decodeUnknownSync(Schema.toType(InventoryBackendConfigurationSchema))({
    ...base.stockInput.selectedBackendConfiguration,
    selection: {
      ...base.stockInput.selectedBackendConfiguration.selection,
      backend: 'external_business_system',
      backendId: 'erp',
    },
  });
  const effectId = '12121212-1212-4212-8212-121212121212';
  const assertionId = '13131313-1313-4313-8313-131313131313';
  const onHand = {
    ...position.position.onHand,
    _tag: 'CURRENT',
    evidenceRef: 'external-stock-fact',
    observedAt: boundary.requiredAt,
    quantity: { amount: '10', unitRef: subject.quantity.unitRef },
  };
  const issuer = { backendId: 'erp', backendKind: 'external_business_system' };
  const externalKey = {
    customerConfigurationId: 'customer',
    externalScope: 'erp-stock',
    externalValue: 'item-1',
    identifierKind: 'ITEM',
    issuer,
    namespace: 'stock',
    tenantId: subject.selection.productRef.tenantId,
  };
  const coverage = [{ assertionId, effectId, ownerEvidenceRef: 'coverage-proof', relation: 'UNKNOWN' }];
  const effectRequest = {
    actionInvocationId: '14141414-1414-4414-8414-141414141414',
    backend: 'external_business_system',
    backendConfigurationRef: onHand.ownerConfigurationRef,
    backendId: 'erp',
    customerConfigurationId: 'customer',
    effectId,
    kind: 'ISSUE',
    legalEntityId: '15151515-1515-4515-8515-151515151515',
    positionRef: position.position.ref,
    quantity: { amount: '1', unitRef: subject.quantity.unitRef },
    reason: { code: 'PHYSICAL_ISSUE', reference: 'issue-1' },
    requestedAt: boundary.requiredAt,
    stockItemRef: position.stockItem.stockItemRef,
    stockLocationRef: position.stockLocation.ref,
  };
  const allocation = {
    allocationId: 'allocation-1',
    positionRef: position.position.ref,
    quantity: { amount: '1', unitRef: subject.quantity.unitRef },
    stockItemRef: position.stockItem.stockItemRef,
  };
  const stock = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
    ...base.stockInput,
    positions: [
      {
        ...position,
        committedObligations: [
          {
            authority,
            importedAt: boundary.requiredAt,
            lifecycleMeaning: 'COMMITTED_OBLIGATION',
            orderProof: {
              acceptedOrderId: 'accepted-order',
              authority: 'ORDER_MIGRATION_PROOF_AUTHORITY',
              commitStatus: 'COMMITTED',
              evidenceRef: 'commit-proof',
              observedAt: boundary.requiredAt,
              sourceOrderId: 'order-1',
              sourceSystem: 'erp',
            },
            origin: {
              kind: 'IMPORTED_PROVEN_ORDER',
              sourceObligationId: 'obligation-1',
              sourceOrderId: 'order-1',
              sourceSystem: 'erp',
            },
            ref: inventoryRef(
              'commerce.inventory.imported-committed-obligation',
              '16161616-1616-4616-8616-161616161616',
            ),
            requirements: [
              {
                allocations: [allocation],
                bindingRef: position.binding.bindingRef,
                catalogSelection: subject.selection,
                exactSelectionMeaning: position.stockItem.exactSelectionMeaning,
                purchaseDemandOccurrenceId: 'occurrence-1',
                quantity: '1',
                stockItem: position.stockItem,
                unitRef: subject.quantity.unitRef,
              },
            ],
            runtimeAttemptId: null,
          },
        ],
        position: { ...position.position, onHand },
        sourceEvidence: {
          _tag: 'EXTERNAL_SOURCE_ASSERTION',
          evaluation: {
            _tag: 'INDETERMINATE',
            assertion: {
              assertionId,
              authorityConfiguration: authority,
              businessObservedAt: boundary.requiredAt,
              coverage,
              customerConfigurationId: 'customer',
              factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
              issuer,
              issuerAuthority: 'SELECTED_BACKEND',
              itemCorrelationRef: inventoryRef(
                'commerce.inventory.external-stock-correlation',
                '19191919-1919-4919-8919-191919191919',
              ),
              itemExternalKey: externalKey,
              locationCorrelationRef: inventoryRef(
                'commerce.inventory.external-stock-correlation',
                '20202020-2020-4020-8020-202020202020',
              ),
              locationExternalKey: { ...externalKey, externalValue: 'location-1', identifierKind: 'LOCATION' },
              orderingEvidence: { _tag: 'SOURCE_REVISION', revision: 'ERP_R1' },
              ownerEvidenceRef: 'source-proof',
              positionRef: position.position.ref,
              quantity: { amount: '10', unitRef: subject.quantity.unitRef },
              receivedAt: boundary.requiredAt,
              sourceReference: 'assertion-1',
              stockItemRef: position.stockItem.stockItemRef,
              stockLocationRef: position.stockLocation.ref,
            },
            materialEffectIds: [effectId],
            postEffectOnHand: null,
            reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
            reconciliationRequired: true,
          },
          materialEffects: [{ _tag: 'REQUESTED', request: effectRequest }],
          onHand,
          ownerConfiguration: authority,
          physicalOnHandReusableProof: 'NOT_PROVIDED',
        },
        unresolvedReservationEffectConstraints: [
          {
            _tag: 'INDETERMINATE',
            attemptId: 'attempt-1',
            authority,
            countsTowardReserved: false,
            effectId: '17171717-1717-4717-8717-171717171717',
            meaning: 'UNRESOLVED_RESERVATION_EFFECT_CONSTRAINT',
            mutationId: '18181818-1818-4818-8818-181818181818',
            possibleAllocations: [
              {
                allocationId: 'allocation-2',
                quantity: { amount: '1', unitRef: subject.quantity.unitRef },
                stockItemRef: position.stockItem.stockItemRef,
                stockPositionRef: position.position.ref,
              },
            ],
            provesReusableOnHand: false,
            reason: 'AUTHORITY_UNAVAILABLE',
            requestedAt: boundary.requiredAt,
            sourceActionInvocationId: effectRequest.actionInvocationId,
          },
        ],
      },
    ],
    selectedBackendConfiguration: authority,
  });
  return {
    ...base,
    ownerQualification: {
      ...base.ownerQualification,
      positions: [
        {
          constraintSupport: 'INDEPENDENTLY_PROVEN',
          positionRef: position.position.ref,
          reusableQuantity: { _tag: 'PROVEN', quantity: { amount: '3', unitRef: subject.quantity.unitRef } },
          uncertaintyReasons: ['SOURCE_COVERAGE_UNCERTAIN', 'UNRESOLVED_RESERVATION_EFFECT'],
          usability: 'USABLE',
        },
      ],
      selectedBackendAuthority: { _tag: 'PROVEN', configuration: authority },
      stockInput: stock,
    },
    stockInput: stock,
  };
};

export const materialPositionChanges = [
  'POSITION_INSERT',
  'POSITION_REMOVE',
  'LIFECYCLE',
  'SHARING',
  'BINDING',
  'COMPLETENESS_LOST',
] as const;

/** Coherent R2 owner inputs with changed facts, not merely invalidation labels. */
export const makeChangedCurrentnessInput = (
  change: (typeof materialPositionChanges)[number],
): AvailabilityEvaluationInput => {
  const quantities = {
    BINDING: ['3'],
    COMPLETENESS_LOST: ['3'],
    LIFECYCLE: ['3'],
    POSITION_INSERT: ['3', '1'],
    POSITION_REMOVE: [],
    SHARING: ['3'],
  };
  const input = makeCurrentnessInput(quantities[change], '2');
  const changedPositions = input.stockInput.positions.map((entry) => {
    if (change === 'LIFECYCLE') {
      const onHand = {
        _tag: 'UNKNOWN' as const,
        meaning: 'ON_HAND' as const,
        ownerConfigurationRef: entry.position.onHand.ownerConfigurationRef,
        unitRef: subject.quantity.unitRef,
      };
      return {
        ...entry,
        position: {
          ...entry.position,
          endedAt: changedAt,
          lifecycle: 'HISTORICAL' as const,
          onHand,
          revision: 2,
        },
        sourceEvidence: { ...entry.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
      };
    }
    if (change === 'BINDING') {
      const stockItemRef = { ...entry.stockItem.stockItemRef, resourceId: '21212121-2121-4121-8121-212121212121' };
      const onHand = {
        ...entry.position.onHand,
        _tag: 'CURRENT' as const,
        evidenceRef: 'bound-item-R2',
        observedAt: changedAt,
        quantity: { amount: '1', unitRef: subject.quantity.unitRef },
      };
      return {
        ...entry,
        binding: { ...entry.binding, effectiveFrom: changedAt, revision: 2, stockItemRef },
        position: { ...entry.position, onHand, revision: 2, scope: { ...entry.position.scope, stockItemRef } },
        sourceEvidence: { ...entry.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
        stockItem: { ...entry.stockItem, stockItemRef },
      };
    }
    return entry;
  });
  const stock = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
    ...input.stockInput,
    positions: changedPositions,
  });
  return {
    ...input,
    ownerQualification: {
      ...input.ownerQualification,
      positions: input.ownerQualification.positions.map((entry) => ({
        ...entry,
        reusableQuantity:
          change === 'BINDING'
            ? { _tag: 'PROVEN' as const, quantity: { amount: '1', unitRef: subject.quantity.unitRef } }
            : entry.reusableQuantity,
        usability: change === 'SHARING' || change === 'LIFECYCLE' ? ('UNUSABLE' as const) : entry.usability,
      })),
      set:
        change === 'COMPLETENESS_LOST'
          ? { _tag: 'UNPROVEN' as const }
          : {
              ...complete,
              evidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
                observedAt: changedAt,
                ownerRevision: 'set-revision-2',
                scope: { kind: 'EXACT_PREDICATE', predicateRef },
              }),
            },
      stockInput: stock,
    },
    stockInput: stock,
  };
};
