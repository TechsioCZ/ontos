import type { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { Effect, Schema } from 'effect';

import { ResolvedCatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import type { ResolvedCatalogStockDemand } from './catalog-to-stock-binding.ts';
import type { ImportedOrderCommitProofRejected } from './imported-order-commit-proof-rejected.ts';
import type { ImportedOrderCommitProofUnavailable } from './imported-order-commit-proof-unavailable.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import type { RuntimeOrderCommitProofRejected } from './runtime-order-commit-proof-rejected.ts';
import type { RuntimeOrderCommitProofUnavailable } from './runtime-order-commit-proof-unavailable.ts';
import { StockQuantitySchema } from './stock-position.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';
import { ImportedCommittedObligationRefSchema } from '../resources/imported-committed-obligation.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

const boundedIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const obligationInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const StockAllocationIdSchema = boundedIdentifier.pipe(Schema.brand('InventoryStockAllocationId'));

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (left: typeof ProductUnitRefSchema.Type, right: typeof ProductUnitRefSchema.Type) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const InventoryStockAllocationSchema = Schema.Struct({
  allocationId: StockAllocationIdSchema,
  positionRef: StockPositionRefSchema,
  quantity: StockQuantitySchema,
  stockItemRef: StockItemRefSchema,
});
export type InventoryStockAllocation = typeof InventoryStockAllocationSchema.Type;

export const InventoryObligationRequirementSchema = Schema.Struct({
  ...ResolvedCatalogStockDemandSchema.fields,
  allocations: Schema.Array(InventoryStockAllocationSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter((requirement) => {
    const { bindingRef, catalogSelection, exactSelectionMeaning, stockItem, unitRef } = requirement;
    if (
      exactSelectionMeaning.id !== stockItem.exactSelectionMeaning.id ||
      exactSelectionMeaning.kind !== stockItem.exactSelectionMeaning.kind
    ) {
      return 'Resolved demand exact Selection meaning must match the immutable Stock Item meaning';
    }
    if (!sameRef(unitRef, stockItem.unitRef)) {
      return 'Resolved demand Unit must match the immutable Stock Item Unit';
    }
    const { tenantId } = catalogSelection.productRef;
    return [bindingRef.tenantId, stockItem.stockItemRef.tenantId, unitRef.tenantId].every(
      (candidate) => candidate === tenantId,
    )
      ? undefined
      : 'Resolved demand provenance, binding, Stock Item, and Unit must share one Tenant';
  }),
);
export type InventoryObligationRequirement = typeof InventoryObligationRequirementSchema.Type;

const RuntimeReservationOriginSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  kind: Schema.Literal('ORDER_COMMITMENT_ATTEMPT'),
});

const ImportedObligationOriginSchema = Schema.Struct({
  kind: Schema.Literal('IMPORTED_PROVEN_ORDER'),
  sourceObligationId: boundedIdentifier.pipe(Schema.brand('ImportedSourceObligationId')),
  sourceOrderId: boundedIdentifier.pipe(Schema.brand('ImportedSourceOrderId')),
  sourceSystem: boundedIdentifier,
});

export const ImportedOrderCommitProofObservationSchema = Schema.Struct({
  acceptedOrderId: boundedIdentifier.pipe(Schema.brand('ImportedAcceptedOrderId')),
  evidenceRef: boundedIdentifier.pipe(Schema.brand('ImportedOrderCommitEvidenceRef')),
  observedAt: obligationInstant,
  sourceOrderId: boundedIdentifier.pipe(Schema.brand('ImportedSourceOrderId')),
  sourceSystem: boundedIdentifier,
});
export type ImportedOrderCommitProofObservation = typeof ImportedOrderCommitProofObservationSchema.Type;

export const VerifiedImportedOrderCommitProofSchema = Schema.Struct({
  ...ImportedOrderCommitProofObservationSchema.fields,
  authority: Schema.Literal('ORDER_MIGRATION_PROOF_AUTHORITY'),
  commitStatus: Schema.Literal('COMMITTED'),
});
export type VerifiedImportedOrderCommitProof = typeof VerifiedImportedOrderCommitProofSchema.Type;

export const RuntimeOrderCommitProofObservationSchema = Schema.Struct({
  acceptedOrderId: boundedIdentifier.pipe(Schema.brand('AcceptedOrderId')),
  attemptId: OrderCommitmentAttemptIdSchema,
  evidenceRef: boundedIdentifier.pipe(Schema.brand('OrderCommitEvidenceRef')),
  observedAt: obligationInstant,
  reservationRef: InventoryReservationRefSchema,
  tenantId: InventoryReservationRefSchema.fields.tenantId,
});
export type RuntimeOrderCommitProofObservation = typeof RuntimeOrderCommitProofObservationSchema.Type;

export const VerifiedRuntimeOrderCommitProofSchema = Schema.Struct({
  ...RuntimeOrderCommitProofObservationSchema.fields,
  authority: Schema.Literal('ORDER_COMMIT_PROOF_AUTHORITY'),
  commitStatus: Schema.Literal('COMMITTED'),
});
export type VerifiedRuntimeOrderCommitProof = typeof VerifiedRuntimeOrderCommitProofSchema.Type;

export const EstablishInventoryReservationInputSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  establishedAt: obligationInstant,
  origin: RuntimeReservationOriginSchema,
  ref: InventoryReservationRefSchema,
  requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
});
export type EstablishInventoryReservationInput = typeof EstablishInventoryReservationInputSchema.Type;

export const ImportCommittedInventoryObligationInputSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  importedAt: obligationInstant,
  orderProofObservation: ImportedOrderCommitProofObservationSchema,
  origin: ImportedObligationOriginSchema,
  ref: ImportedCommittedObligationRefSchema,
  requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
  runtimeAttemptId: Schema.Null,
});
export type ImportCommittedInventoryObligationInput = typeof ImportCommittedInventoryObligationInputSchema.Type;

export const ProvisionalInventoryReservationSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  establishedAt: obligationInstant,
  lifecycleMeaning: Schema.Literal('PROVISIONAL_RESERVATION'),
  origin: RuntimeReservationOriginSchema,
  ref: InventoryReservationRefSchema,
  requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
});
export type ProvisionalInventoryReservation = typeof ProvisionalInventoryReservationSchema.Type;

export const CommitInventoryReservationInputSchema = Schema.Struct({
  orderProofObservation: RuntimeOrderCommitProofObservationSchema,
  reservation: ProvisionalInventoryReservationSchema,
});
export type CommitInventoryReservationInput = typeof CommitInventoryReservationInputSchema.Type;

export const RuntimeCommittedInventoryObligationSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  confirmationTerminationReleasesStock: Schema.Literal(false),
  establishedAt: obligationInstant,
  historicalBindingPolicy: Schema.Literal('PRESERVE_AND_RECONCILE'),
  lifecycleMeaning: Schema.Literal('COMMITTED_OBLIGATION'),
  obligationReductionCreatesOnHand: Schema.Literal(false),
  orderProof: VerifiedRuntimeOrderCommitProofSchema,
  origin: RuntimeReservationOriginSchema,
  physicalIssueBoundary: Schema.Literal('SEPARATE_INVENTORY_TRANSITION'),
  ref: InventoryReservationRefSchema,
  remainingQuantityConstraint: Schema.Literal('OWNER_GOVERNED_TRANSITION_REQUIRED'),
  requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ orderProof, origin, ref }) =>
    orderProof.tenantId === ref.tenantId &&
    orderProof.attemptId === origin.attemptId &&
    sameRef(orderProof.reservationRef, ref)
      ? undefined
      : 'Order commit proof must match the exact Reservation Tenant, Attempt, and identity',
  ),
);
export type RuntimeCommittedInventoryObligation = typeof RuntimeCommittedInventoryObligationSchema.Type;

export const ImportedCommittedObligationSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  importedAt: obligationInstant,
  lifecycleMeaning: Schema.Literal('COMMITTED_OBLIGATION'),
  orderProof: VerifiedImportedOrderCommitProofSchema,
  origin: ImportedObligationOriginSchema,
  ref: ImportedCommittedObligationRefSchema,
  requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
  runtimeAttemptId: Schema.Null,
});
export type ImportedCommittedObligation = typeof ImportedCommittedObligationSchema.Type;

export const InventoryObligationSchema = Schema.Union([
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
  ImportedCommittedObligationSchema,
]);
export type InventoryObligation = typeof InventoryObligationSchema.Type;

export class InventoryObligationRejected extends Schema.TaggedError<InventoryObligationRejected>()(
  'InventoryObligationRejected',
  {
    code: Schema.Literal('inventory_obligation_rejected'),
    purchaseDemandOccurrenceId: Schema.optionalKey(ResolvedCatalogStockDemandSchema.fields.purchaseDemandOccurrenceId),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'SELECTED_AUTHORITY_REQUIRED',
      'DUPLICATE_DEMAND_OCCURRENCE',
      'DUPLICATE_ALLOCATION_IDENTITY',
      'ALLOCATION_ITEM_MISMATCH',
      'ALLOCATION_UNIT_MISMATCH',
      'ALLOCATION_QUANTITY_MISMATCH',
      'IDENTITY_NAMESPACE_COLLISION',
      'RESOLVED_DEMAND_MISMATCH',
      'IMPORT_PROOF_REJECTED',
      'IMPORT_PROOF_SCOPE_MISMATCH',
      'ATTEMPT_ALREADY_BOUND',
      'OBLIGATION_IDENTITY_CONFLICT',
      'SOURCE_LINEAGE_ALREADY_IMPORTED',
      'ORDER_COMMIT_BINDING_CONFLICT',
      'ORDER_COMMIT_PROOF_SCOPE_MISMATCH',
      'RESERVATION_NOT_PROVISIONAL',
      'INVALID_PERSISTED_OBLIGATION',
    ]),
  },
) {}

export { ImportedOrderCommitProofRejected } from './imported-order-commit-proof-rejected.ts';

/** Implemented only by the trusted migration owner; caller literals never establish committed truth. */
export interface ImportedOrderCommitProofVerifier {
  readonly verifyCommitted: (
    observation: ImportedOrderCommitProofObservation,
  ) => Effect.Effect<
    VerifiedImportedOrderCommitProof,
    ImportedOrderCommitProofRejected | ImportedOrderCommitProofUnavailable
  >;
}

/** Implemented only by the trusted Order evidence adapter; caller literals never establish committed truth. */
export interface RuntimeOrderCommitProofVerifier {
  readonly verifyCommitted: (
    observation: RuntimeOrderCommitProofObservation,
  ) => Effect.Effect<
    VerifiedRuntimeOrderCommitProof,
    RuntimeOrderCommitProofRejected | RuntimeOrderCommitProofUnavailable
  >;
}

const rejection = (
  reason: InventoryObligationRejected['reason'],
  purchaseDemandOccurrenceId?: ResolvedCatalogStockDemand['purchaseDemandOccurrenceId'],
) =>
  purchaseDemandOccurrenceId === undefined
    ? new InventoryObligationRejected({ code: 'inventory_obligation_rejected', reason })
    : new InventoryObligationRejected({
        code: 'inventory_obligation_rejected',
        purchaseDemandOccurrenceId,
        reason,
      });

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (amount: string): DecimalParts => {
  const [integer = '0', fraction = ''] = amount.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const sumAmounts = (amounts: readonly string[]): DecimalParts => {
  let scale = 0;
  for (const amount of amounts) {
    scale = Math.max(scale, decimalParts(amount).scale);
  }
  let coefficient = 0n;
  for (const amount of amounts) {
    const parts = decimalParts(amount);
    coefficient += parts.coefficient * 10n ** BigInt(scale - parts.scale);
  }
  return { coefficient, scale };
};

const equalAmount = (left: string, right: DecimalParts): boolean => {
  const leftParts = decimalParts(left);
  const scale = Math.max(leftParts.scale, right.scale);
  return (
    leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale) ===
    right.coefficient * 10n ** BigInt(scale - right.scale)
  );
};

const validateRequirements = Effect.fn('InventoryObligation.validateRequirements')(
  function* validateObligationRequirements(tenantId: string, requirements: readonly InventoryObligationRequirement[]) {
    const occurrenceIds = new Set<string>();
    const allocationIds = new Set<string>();
    for (const requirement of requirements) {
      if (occurrenceIds.has(requirement.purchaseDemandOccurrenceId)) {
        return yield* rejection('DUPLICATE_DEMAND_OCCURRENCE', requirement.purchaseDemandOccurrenceId);
      }
      occurrenceIds.add(requirement.purchaseDemandOccurrenceId);
      if (
        requirement.bindingRef.tenantId !== tenantId ||
        requirement.catalogSelection.productRef.tenantId !== tenantId ||
        requirement.stockItem.stockItemRef.tenantId !== tenantId ||
        requirement.unitRef.tenantId !== tenantId
      ) {
        return yield* rejection('TENANT_SCOPE_MISMATCH', requirement.purchaseDemandOccurrenceId);
      }
      if (
        requirement.exactSelectionMeaning.id !== requirement.stockItem.exactSelectionMeaning.id ||
        requirement.exactSelectionMeaning.kind !== requirement.stockItem.exactSelectionMeaning.kind ||
        !sameRef(requirement.unitRef, requirement.stockItem.unitRef)
      ) {
        return yield* rejection('RESOLVED_DEMAND_MISMATCH', requirement.purchaseDemandOccurrenceId);
      }
      for (const allocation of requirement.allocations) {
        if (allocationIds.has(allocation.allocationId)) {
          return yield* rejection('DUPLICATE_ALLOCATION_IDENTITY', requirement.purchaseDemandOccurrenceId);
        }
        allocationIds.add(allocation.allocationId);
        if (
          allocation.positionRef.tenantId !== tenantId ||
          allocation.stockItemRef.tenantId !== tenantId ||
          allocation.quantity.unitRef.tenantId !== tenantId
        ) {
          return yield* rejection('TENANT_SCOPE_MISMATCH', requirement.purchaseDemandOccurrenceId);
        }
        if (!sameRef(allocation.stockItemRef, requirement.stockItem.stockItemRef)) {
          return yield* rejection('ALLOCATION_ITEM_MISMATCH', requirement.purchaseDemandOccurrenceId);
        }
        if (!sameUnit(allocation.quantity.unitRef, requirement.unitRef)) {
          return yield* rejection('ALLOCATION_UNIT_MISMATCH', requirement.purchaseDemandOccurrenceId);
        }
      }
      if (
        !equalAmount(requirement.quantity, sumAmounts(requirement.allocations.map(({ quantity }) => quantity.amount)))
      ) {
        return yield* rejection('ALLOCATION_QUANTITY_MISMATCH', requirement.purchaseDemandOccurrenceId);
      }
    }
    return yield* Effect.void;
  },
);

export const establishInventoryReservation = Effect.fn('establishInventoryReservation')(function* establishReservation(
  input: EstablishInventoryReservationInput,
) {
  if (String(input.ref.tenantId) !== String(input.authority.tenantId)) {
    return yield* rejection('TENANT_SCOPE_MISMATCH');
  }
  if (input.authority.selection.exactReservationCapability !== 'SUPPORTED') {
    return yield* rejection('SELECTED_AUTHORITY_REQUIRED');
  }
  if (String(input.ref.resourceId) === String(input.origin.attemptId)) {
    return yield* rejection('IDENTITY_NAMESPACE_COLLISION');
  }
  yield* validateRequirements(input.ref.tenantId, input.requirements);
  return {
    authority: input.authority,
    establishedAt: input.establishedAt,
    lifecycleMeaning: 'PROVISIONAL_RESERVATION' as const,
    origin: input.origin,
    ref: input.ref,
    requirements: input.requirements,
  } satisfies ProvisionalInventoryReservation;
});

export const makeInventoryReservationCommitter = (proofVerifier: RuntimeOrderCommitProofVerifier) => ({
  commit: Effect.fn('InventoryReservationCommitter.commit')(function* commitReservation(
    input: CommitInventoryReservationInput,
  ) {
    const { orderProofObservation, reservation } = input;
    if (
      orderProofObservation.tenantId !== reservation.ref.tenantId ||
      orderProofObservation.attemptId !== reservation.origin.attemptId ||
      !sameRef(orderProofObservation.reservationRef, reservation.ref)
    ) {
      return yield* rejection('ORDER_COMMIT_PROOF_SCOPE_MISMATCH');
    }
    const orderProof = yield* proofVerifier.verifyCommitted(orderProofObservation);
    if (
      orderProof.acceptedOrderId !== orderProofObservation.acceptedOrderId ||
      orderProof.attemptId !== reservation.origin.attemptId ||
      orderProof.evidenceRef !== orderProofObservation.evidenceRef ||
      orderProof.observedAt !== orderProofObservation.observedAt ||
      orderProof.tenantId !== reservation.ref.tenantId ||
      !sameRef(orderProof.reservationRef, reservation.ref)
    ) {
      return yield* rejection('ORDER_COMMIT_PROOF_SCOPE_MISMATCH');
    }
    return {
      authority: reservation.authority,
      confirmationTerminationReleasesStock: false as const,
      establishedAt: reservation.establishedAt,
      historicalBindingPolicy: 'PRESERVE_AND_RECONCILE' as const,
      lifecycleMeaning: 'COMMITTED_OBLIGATION' as const,
      obligationReductionCreatesOnHand: false as const,
      orderProof,
      origin: reservation.origin,
      physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION' as const,
      ref: reservation.ref,
      remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED' as const,
      requirements: reservation.requirements,
    } satisfies RuntimeCommittedInventoryObligation;
  }),
});

export const makeImportedCommittedObligationImporter = (proofVerifier: ImportedOrderCommitProofVerifier) => ({
  import: Effect.fn('ImportedCommittedObligationImporter.import')(function* importObligation(
    input: ImportCommittedInventoryObligationInput,
  ) {
    if (String(input.ref.tenantId) !== String(input.authority.tenantId)) {
      return yield* rejection('TENANT_SCOPE_MISMATCH');
    }
    if (input.authority.selection.exactReservationCapability !== 'SUPPORTED') {
      return yield* rejection('SELECTED_AUTHORITY_REQUIRED');
    }
    if (
      [
        input.orderProofObservation.acceptedOrderId,
        input.orderProofObservation.sourceOrderId,
        input.origin.sourceOrderId,
        input.origin.sourceObligationId,
      ].some((candidate) => String(candidate) === String(input.ref.resourceId))
    ) {
      return yield* rejection('IDENTITY_NAMESPACE_COLLISION');
    }
    if (
      input.orderProofObservation.sourceSystem !== input.origin.sourceSystem ||
      input.orderProofObservation.sourceOrderId !== input.origin.sourceOrderId
    ) {
      return yield* rejection('IMPORT_PROOF_SCOPE_MISMATCH');
    }
    const orderProof = yield* proofVerifier.verifyCommitted(input.orderProofObservation);
    if (
      orderProof.acceptedOrderId !== input.orderProofObservation.acceptedOrderId ||
      orderProof.evidenceRef !== input.orderProofObservation.evidenceRef ||
      orderProof.observedAt !== input.orderProofObservation.observedAt ||
      orderProof.sourceOrderId !== input.origin.sourceOrderId ||
      orderProof.sourceSystem !== input.origin.sourceSystem
    ) {
      return yield* rejection('IMPORT_PROOF_SCOPE_MISMATCH');
    }
    yield* validateRequirements(input.ref.tenantId, input.requirements);
    return {
      authority: input.authority,
      importedAt: input.importedAt,
      lifecycleMeaning: 'COMMITTED_OBLIGATION' as const,
      orderProof,
      origin: input.origin,
      ref: input.ref,
      requirements: input.requirements,
      runtimeAttemptId: null,
    } satisfies ImportedCommittedObligation;
  }),
});
