import { Effect, Schema } from 'effect';

import type { InventoryBackendConfigurationInput, InventoryLaunchCutlineRejected } from '../inventory-launch-scope.ts';
import {
  InventoryBackendSchema,
  OrderCommitmentAttemptIdSchema,
  validateLaunchInventoryBackend,
} from '../inventory-launch-scope.ts';
import { InventoryReservationIdSchema } from '../resources/inventory-reservation.ts';

const AuthorityIdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const AcceptedOrderIdSchema = AuthorityIdentifierSchema.pipe(Schema.brand('AcceptedOrderId'));
const CustomerConfigurationIdSchema = AuthorityIdentifierSchema.pipe(Schema.brand('CustomerConfigurationId'));
const InventoryStockPositionIdSchema = AuthorityIdentifierSchema.pipe(Schema.brand('InventoryStockPositionId'));
export type InventoryReservationId = typeof InventoryReservationIdSchema.Type;
export type OrderCommitmentAttemptId = typeof OrderCommitmentAttemptIdSchema.Type;

const inventoryAuthorityAssignmentBase = {
  authorityMode: Schema.Literal('SINGLE_CUSTOMER_CONFIGURATION_BACKEND'),
  customerConfigurationId: CustomerConfigurationIdSchema,
  cutoverMode: Schema.Literal('EXPLICIT_ONLY'),
  fallbackBackend: Schema.Null,
} as const;

export const InventoryAuthorityAssignmentSchema = Schema.Union([
  Schema.Struct({
    ...inventoryAuthorityAssignmentBase,
    ownerAccess: Schema.Literal('DIRECT_EXTERNAL_OWNER_CONTRACT'),
    physicalStockSystemOfRecord: Schema.Literal('external_business_system'),
    reservationAuthority: Schema.Literal('external_business_system'),
    selectedBackend: Schema.Literal('external_business_system'),
  }),
  Schema.Struct({
    ...inventoryAuthorityAssignmentBase,
    ownerAccess: Schema.Literal('ONTOS_WMS_OWNER_CONTRACT'),
    physicalStockSystemOfRecord: Schema.Literal('ontos_wms'),
    reservationAuthority: Schema.Literal('ontos_wms'),
    selectedBackend: Schema.Literal('ontos_wms'),
  }),
]);
export type InventoryAuthorityAssignment = typeof InventoryAuthorityAssignmentSchema.Type;

export const InventoryNonAuthorityBoundarySchema = Schema.Union([
  Schema.Struct({
    participant: Schema.Literal('INTEGRATION_ROUTE'),
    role: Schema.Literal('TRANSPORT_ONLY'),
  }),
  Schema.Struct({
    participant: Schema.Literal('LOCAL_INVENTORY_BOOKKEEPING'),
    role: Schema.Literal('EVIDENCE_ONLY'),
  }),
  Schema.Struct({
    participant: Schema.Literal('AVAILABILITY'),
    role: Schema.Literal('READ_OWNER_EVIDENCE_ONLY'),
  }),
  Schema.Struct({
    participant: Schema.Literal('ORDER'),
    role: Schema.Literal('OWNS_ACCEPTED_PURCHASE_ONLY'),
  }),
  Schema.Struct({
    participant: Schema.Literal('FULFILLMENT'),
    role: Schema.Literal('EXECUTION_EVIDENCE_ONLY'),
  }),
]);
export type InventoryNonAuthorityBoundary = typeof InventoryNonAuthorityBoundarySchema.Type;

export const inventoryNonAuthorityBoundaries = [
  { participant: 'INTEGRATION_ROUTE', role: 'TRANSPORT_ONLY' },
  { participant: 'LOCAL_INVENTORY_BOOKKEEPING', role: 'EVIDENCE_ONLY' },
  { participant: 'AVAILABILITY', role: 'READ_OWNER_EVIDENCE_ONLY' },
  { participant: 'ORDER', role: 'OWNS_ACCEPTED_PURCHASE_ONLY' },
  { participant: 'FULFILLMENT', role: 'EXECUTION_EVIDENCE_ONLY' },
] as const satisfies readonly InventoryNonAuthorityBoundary[];

const InventoryReservationAllocationAuthoritySchema = Schema.Struct({
  authorityBackend: InventoryBackendSchema,
  stockPositionId: InventoryStockPositionIdSchema,
});

export const InventoryReservationAuthorityProposalSchema = Schema.Struct({
  allocations: Schema.Array(InventoryReservationAllocationAuthoritySchema).check(Schema.isMinLength(1)),
  attemptId: OrderCommitmentAttemptIdSchema,
  authority: InventoryAuthorityAssignmentSchema,
  reservationIds: Schema.Array(InventoryReservationIdSchema),
});
export type InventoryReservationAuthorityProposal = typeof InventoryReservationAuthorityProposalSchema.Type;

export const InventoryReservationAuthorityDecisionSchema = Schema.Struct({
  allocationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  attemptId: OrderCommitmentAttemptIdSchema,
  coverage: Schema.Literal('ALL_ATTEMPT_STOCK_REQUIREMENTS'),
  reservationAuthority: InventoryBackendSchema,
  reservationId: InventoryReservationIdSchema,
  reservationIdentityStatus: Schema.Literals(['ESTABLISHED', 'EXACT_RETRY']),
});
export type InventoryReservationAuthorityDecision = typeof InventoryReservationAuthorityDecisionSchema.Type;

export const InventoryAttemptReservationIdentityBindingInputSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  proposedReservationId: InventoryReservationIdSchema,
});
export type InventoryAttemptReservationIdentityBindingInput =
  typeof InventoryAttemptReservationIdentityBindingInputSchema.Type;

export const InventoryAttemptReservationIdentityBindingSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  reservationId: InventoryReservationIdSchema,
  status: Schema.Literals(['BOUND_NOW', 'ALREADY_BOUND']),
});
export type InventoryAttemptReservationIdentityBinding = typeof InventoryAttemptReservationIdentityBindingSchema.Type;

export interface InventoryAttemptReservationIdentityAuthority {
  readonly readOrBind: (
    input: InventoryAttemptReservationIdentityBindingInput,
  ) => Effect.Effect<InventoryAttemptReservationIdentityBinding, InventoryAuthorityDecisionRejected>;
}

export const InventoryAuthorityOperationSchema = Schema.Literals([
  'PHYSICAL_STOCK_FACT',
  'RESERVATION_CREATE',
  'RESERVATION_RELEASE',
  'RESERVATION_CONFIRMATION',
  'COMMITMENT_PROTECTION',
]);

const InventoryEvidenceIssuerSchema = Schema.Union([
  Schema.Struct({
    backend: InventoryBackendSchema,
    kind: Schema.Literal('INVENTORY_BACKEND'),
  }),
  Schema.Struct({ kind: Schema.Literal('LOCAL_INVENTORY_BOOKKEEPING') }),
  Schema.Struct({ kind: Schema.Literal('INTEGRATION_ROUTE') }),
]);

const InventoryOwnerEvidenceObservationSchema = Schema.Union([
  Schema.Struct({
    issuer: InventoryEvidenceIssuerSchema,
    kind: Schema.Literal('CONFIRMED'),
    ownerEvidenceRef: AuthorityIdentifierSchema,
    verification: Schema.Literal('OWNER_VERIFIED'),
  }),
  Schema.Struct({ kind: Schema.Literal('UNSUPPORTED') }),
  Schema.Struct({ kind: Schema.Literal('UNAVAILABLE') }),
  Schema.Struct({ kind: Schema.Literal('CONFLICT') }),
  Schema.Struct({ kind: Schema.Literal('INDETERMINATE') }),
]);

export const InventoryOwnerEvidenceInputSchema = Schema.Struct({
  authority: InventoryAuthorityAssignmentSchema,
  observation: InventoryOwnerEvidenceObservationSchema,
  operation: InventoryAuthorityOperationSchema,
});
export type InventoryOwnerEvidenceInput = typeof InventoryOwnerEvidenceInputSchema.Type;

export const InventoryOwnerEvidenceDecisionSchema = Schema.Struct({
  authorityRole: Schema.Literals(['PHYSICAL_STOCK_SYSTEM_OF_RECORD', 'RESERVATION_AUTHORITY']),
  issuerBackend: InventoryBackendSchema,
  kind: Schema.Literal('AUTHORITATIVE_OWNER_EVIDENCE'),
  operation: InventoryAuthorityOperationSchema,
  ownerEvidenceRef: AuthorityIdentifierSchema,
});
export type InventoryOwnerEvidenceDecision = typeof InventoryOwnerEvidenceDecisionSchema.Type;

export const InventoryCommitContinuationInputSchema = Schema.Struct({
  acceptedOrderEvidenceRef: AuthorityIdentifierSchema,
  acceptedOrderId: AcceptedOrderIdSchema,
  attemptId: OrderCommitmentAttemptIdSchema,
  currentMeaning: Schema.Literal('PROVISIONAL_RESERVATION'),
  reservationObligationId: InventoryReservationIdSchema,
});
export type InventoryCommitContinuationInput = typeof InventoryCommitContinuationInputSchema.Type;

export const CommittedInventoryObligationSchema = Schema.Struct({
  acceptedOrderEvidenceRef: AuthorityIdentifierSchema,
  acceptedOrderId: AcceptedOrderIdSchema,
  attemptId: OrderCommitmentAttemptIdSchema,
  fulfillmentRole: Schema.Literal('EXECUTION_EVIDENCE_ONLY'),
  lifecycleMeaning: Schema.Literal('COMMITTED_OBLIGATION'),
  obligationOwner: Schema.Literal('INVENTORY'),
  orderOwnerRole: Schema.Literal('ACCEPTED_PURCHASE'),
  reservationObligationId: InventoryReservationIdSchema,
});
export type CommittedInventoryObligation = typeof CommittedInventoryObligationSchema.Type;

export const InventoryBackendContinuityInputSchema = Schema.Struct({
  currentAuthority: InventoryAuthorityAssignmentSchema,
  requestedBackend: InventoryBackendSchema,
});
export type InventoryBackendContinuityInput = typeof InventoryBackendContinuityInputSchema.Type;

export const InventoryBackendContinuityDecisionSchema = Schema.Struct({
  backend: InventoryBackendSchema,
  mode: Schema.Literal('UNCHANGED_RUNTIME_AUTHORITY'),
});
export type InventoryBackendContinuityDecision = typeof InventoryBackendContinuityDecisionSchema.Type;

export class InventoryAuthorityDecisionRejected extends Schema.TaggedError<InventoryAuthorityDecisionRejected>()(
  'InventoryAuthorityDecisionRejected',
  {
    attemptId: Schema.optionalKey(OrderCommitmentAttemptIdSchema),
    code: Schema.Literal('inventory_authority_decision_rejected'),
    customerConfigurationId: Schema.optionalKey(CustomerConfigurationIdSchema),
    fallbackApplied: Schema.Literal(false),
    outcome: Schema.Literals([
      'unsupported',
      'unavailable',
      'conflict',
      'indeterminate',
      'invalid_cardinality',
      'authority_mismatch',
      'cutover_required',
    ]),
    reason: Schema.Literals([
      'selected_backend_does_not_support_required_guarantee',
      'selected_backend_unavailable',
      'selected_backend_evidence_conflict',
      'selected_backend_evidence_indeterminate',
      'exactly_one_reservation_per_attempt_required',
      'all_allocations_require_selected_backend',
      'attempt_reservation_identity_conflict',
      'backend_change_requires_explicit_cutover',
      'owner_evidence_issuer_mismatch',
    ]),
    resolution: Schema.Literals([
      'customer_configuration_change_required',
      'owner_resolution_required',
      'reservation_proposal_correction_required',
      'explicit_cutover_required',
    ]),
    selectedBackend: InventoryBackendSchema,
  },
) {}

export const establishInventoryAuthority = (
  input: InventoryBackendConfigurationInput,
): Effect.Effect<InventoryAuthorityAssignment, InventoryLaunchCutlineRejected> =>
  validateLaunchInventoryBackend(input).pipe(
    Effect.map(({ backend, customerConfigurationId }) => {
      const shared = {
        authorityMode: 'SINGLE_CUSTOMER_CONFIGURATION_BACKEND' as const,
        customerConfigurationId,
        cutoverMode: 'EXPLICIT_ONLY' as const,
        fallbackBackend: null,
      };

      return backend === 'external_business_system'
        ? {
            ...shared,
            ownerAccess: 'DIRECT_EXTERNAL_OWNER_CONTRACT' as const,
            physicalStockSystemOfRecord: backend,
            reservationAuthority: backend,
            selectedBackend: backend,
          }
        : {
            ...shared,
            ownerAccess: 'ONTOS_WMS_OWNER_CONTRACT' as const,
            physicalStockSystemOfRecord: backend,
            reservationAuthority: backend,
            selectedBackend: backend,
          };
    }),
  );

const validateInventoryReservationProposal = (
  proposal: InventoryReservationAuthorityProposal,
): Effect.Effect<
  Omit<InventoryReservationAuthorityDecision, 'reservationIdentityStatus'>,
  InventoryAuthorityDecisionRejected
> => {
  const [reservationId] = proposal.reservationIds;
  if (proposal.reservationIds.length !== 1 || reservationId === undefined) {
    return Effect.fail(
      new InventoryAuthorityDecisionRejected({
        attemptId: proposal.attemptId,
        code: 'inventory_authority_decision_rejected',
        fallbackApplied: false,
        outcome: 'invalid_cardinality',
        reason: 'exactly_one_reservation_per_attempt_required',
        resolution: 'reservation_proposal_correction_required',
        selectedBackend: proposal.authority.selectedBackend,
      }),
    );
  }

  if (proposal.allocations.some(({ authorityBackend }) => authorityBackend !== proposal.authority.selectedBackend)) {
    return Effect.fail(
      new InventoryAuthorityDecisionRejected({
        attemptId: proposal.attemptId,
        code: 'inventory_authority_decision_rejected',
        fallbackApplied: false,
        outcome: 'authority_mismatch',
        reason: 'all_allocations_require_selected_backend',
        resolution: 'reservation_proposal_correction_required',
        selectedBackend: proposal.authority.selectedBackend,
      }),
    );
  }

  return Effect.succeed({
    allocationCount: proposal.allocations.length,
    attemptId: proposal.attemptId,
    coverage: 'ALL_ATTEMPT_STOCK_REQUIREMENTS',
    reservationAuthority: proposal.authority.reservationAuthority,
    reservationId,
  });
};

export const makeInventoryReservationAuthorityService = (
  identityAuthority: InventoryAttemptReservationIdentityAuthority,
) => ({
  establish: (
    proposal: InventoryReservationAuthorityProposal,
  ): Effect.Effect<InventoryReservationAuthorityDecision, InventoryAuthorityDecisionRejected> =>
    validateInventoryReservationProposal(proposal).pipe(
      Effect.flatMap((validated) =>
        identityAuthority
          .readOrBind({
            attemptId: validated.attemptId,
            proposedReservationId: validated.reservationId,
          })
          .pipe(
            Effect.flatMap((binding) => {
              if (binding.reservationId !== validated.reservationId) {
                return Effect.fail(
                  new InventoryAuthorityDecisionRejected({
                    attemptId: validated.attemptId,
                    code: 'inventory_authority_decision_rejected',
                    fallbackApplied: false,
                    outcome: 'conflict',
                    reason: 'attempt_reservation_identity_conflict',
                    resolution: 'reservation_proposal_correction_required',
                    selectedBackend: proposal.authority.selectedBackend,
                  }),
                );
              }

              return Effect.succeed({
                ...validated,
                reservationIdentityStatus:
                  binding.status === 'BOUND_NOW' ? ('ESTABLISHED' as const) : ('EXACT_RETRY' as const),
              });
            }),
          ),
      ),
    ),
});

export const resolveInventoryOwnerEvidence = (
  input: InventoryOwnerEvidenceInput,
): Effect.Effect<InventoryOwnerEvidenceDecision, InventoryAuthorityDecisionRejected> => {
  if (input.observation.kind === 'CONFIRMED') {
    if (
      input.observation.issuer.kind !== 'INVENTORY_BACKEND' ||
      input.observation.issuer.backend !== input.authority.selectedBackend
    ) {
      return Effect.fail(
        new InventoryAuthorityDecisionRejected({
          code: 'inventory_authority_decision_rejected',
          customerConfigurationId: input.authority.customerConfigurationId,
          fallbackApplied: false,
          outcome: 'conflict',
          reason: 'owner_evidence_issuer_mismatch',
          resolution: 'owner_resolution_required',
          selectedBackend: input.authority.selectedBackend,
        }),
      );
    }

    return Effect.succeed({
      authorityRole:
        input.operation === 'PHYSICAL_STOCK_FACT' ? 'PHYSICAL_STOCK_SYSTEM_OF_RECORD' : 'RESERVATION_AUTHORITY',
      issuerBackend: input.observation.issuer.backend,
      kind: 'AUTHORITATIVE_OWNER_EVIDENCE',
      operation: input.operation,
      ownerEvidenceRef: input.observation.ownerEvidenceRef,
    });
  }

  const rejection = {
    CONFLICT: {
      outcome: 'conflict' as const,
      reason: 'selected_backend_evidence_conflict' as const,
      resolution: 'owner_resolution_required' as const,
    },
    INDETERMINATE: {
      outcome: 'indeterminate' as const,
      reason: 'selected_backend_evidence_indeterminate' as const,
      resolution: 'owner_resolution_required' as const,
    },
    UNAVAILABLE: {
      outcome: 'unavailable' as const,
      reason: 'selected_backend_unavailable' as const,
      resolution: 'owner_resolution_required' as const,
    },
    UNSUPPORTED: {
      outcome: 'unsupported' as const,
      reason: 'selected_backend_does_not_support_required_guarantee' as const,
      resolution: 'customer_configuration_change_required' as const,
    },
  }[input.observation.kind];

  return Effect.fail(
    new InventoryAuthorityDecisionRejected({
      code: 'inventory_authority_decision_rejected',
      customerConfigurationId: input.authority.customerConfigurationId,
      fallbackApplied: false,
      ...rejection,
      selectedBackend: input.authority.selectedBackend,
    }),
  );
};

export const continueInventoryObligationAfterCommit = (
  input: InventoryCommitContinuationInput,
): Effect.Effect<CommittedInventoryObligation> =>
  Effect.succeed({
    acceptedOrderEvidenceRef: input.acceptedOrderEvidenceRef,
    acceptedOrderId: input.acceptedOrderId,
    attemptId: input.attemptId,
    fulfillmentRole: 'EXECUTION_EVIDENCE_ONLY',
    lifecycleMeaning: 'COMMITTED_OBLIGATION',
    obligationOwner: 'INVENTORY',
    orderOwnerRole: 'ACCEPTED_PURCHASE',
    reservationObligationId: input.reservationObligationId,
  });

export const requireExplicitBackendCutover = (
  input: InventoryBackendContinuityInput,
): Effect.Effect<InventoryBackendContinuityDecision, InventoryAuthorityDecisionRejected> => {
  if (input.requestedBackend === input.currentAuthority.selectedBackend) {
    return Effect.succeed({
      backend: input.currentAuthority.selectedBackend,
      mode: 'UNCHANGED_RUNTIME_AUTHORITY',
    });
  }

  return Effect.fail(
    new InventoryAuthorityDecisionRejected({
      code: 'inventory_authority_decision_rejected',
      customerConfigurationId: input.currentAuthority.customerConfigurationId,
      fallbackApplied: false,
      outcome: 'cutover_required',
      reason: 'backend_change_requires_explicit_cutover',
      resolution: 'explicit_cutover_required',
      selectedBackend: input.currentAuthority.selectedBackend,
    }),
  );
};
