import { ActionPermissionDenied } from '@app/core-runtime';
import { Match, Schema } from 'effect';

import { CatalogToStockBindingResolutionFailure } from './catalog-to-stock-binding-resolution.ts';
import { CatalogStockDemandSchema, CatalogToStockBindingSchema } from './catalog-to-stock-binding.ts';
import {
  EstablishCommitmentProtectionErrorSchema,
  EstablishCommitmentProtectionResultSchema,
} from './commitment-protection.ts';
import {
  CompensateInventoryPreCommitErrorSchema,
  CompensateInventoryPreCommitResultSchema,
} from './inventory-pre-commit-compensation.ts';
import {
  SelectInventoryBackendErrorSchema,
  SelectInventoryBackendResultSchema,
} from './inventory-backend-configuration.ts';
import {
  CreateInventoryReservationErrorSchema,
  CreateInventoryReservationResultSchema,
} from './inventory-reservation-create.ts';
import {
  ReleaseInventoryReservationErrorSchema,
  ReleaseInventoryReservationResultSchema,
} from './inventory-reservation-release.ts';
import { RuntimeCommittedInventoryObligationSchema } from './inventory-obligation.ts';
import {
  ReservationConfirmationRejected,
  ReservationConfirmationSchema,
  ReservationConfirmationUnavailable,
} from './reservation-confirmation.ts';
import { ReservationAuthorityUnavailable } from './reservation-authority-unavailable.ts';
import { ReservationEffectIndeterminate } from './reservation-effect-indeterminate.ts';
import { ReservationShortageImpactEvaluationSchema } from './reservation-shortage-impact.ts';
import { InventorySourceAssertionEvaluationSchema } from './inventory-source-assertion.ts';
import {
  CurrentOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  MissingOnHandEvidenceSchema,
  StaleOnHandEvidenceSchema,
  StockQuantitySchema,
  UnknownOnHandEvidenceSchema,
  compareExactStockQuantityAmounts,
} from './stock-position.ts';
import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export { UnresolvedReservationEffectConstraintSchema as InventoryUnresolvedReservationEffectConstraintOutcomeSchema } from './current-stock-evidence-for-availability.ts';

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Binding resolution is its own capability; its MISSING outcome is not Stock Evidence MISSING. */
export const CatalogBindingCapabilityOutcomeSchema = Schema.Union([
  Schema.Struct({ binding: CatalogToStockBindingSchema, outcome: Schema.Literal('RESOLVED') }),
  CatalogToStockBindingResolutionFailure,
]);

export const inventoryBindingResolutionNextStep = (
  outcome: 'RESOLVED' | CatalogToStockBindingResolutionFailure['outcome'],
) => (outcome === 'RESOLVED' ? ('CONTINUE' as const) : ('REPAIR_BINDING' as const));

/** Structural decoding failures stay outside this business result; these are exact semantic input outcomes. */
export const InventoryReservationDemandInputOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('VALID', {
    purchaseDemandOccurrenceId: CatalogStockDemandSchema.fields.purchaseDemandOccurrenceId,
    requestedQuantity: StockQuantitySchema,
  }),
  Schema.TaggedStruct('REJECTED', {
    purchaseDemandOccurrenceId: CatalogStockDemandSchema.fields.purchaseDemandOccurrenceId,
    reason: Schema.Literals(['INVALID_REQUESTED_QUANTITY', 'INCOMPATIBLE_REQUESTED_UNIT']),
  }),
]);

export const inventoryReservationDemandInputNextStep = (outcome: 'VALID' | 'REJECTED') =>
  outcome === 'VALID' ? ('CONTINUE' as const) : ('REPAIR_INPUT' as const);

/** A known shortage is numeric owner evidence, never an alias for missing or uncertain evidence. */
export const KnownInsufficientConstrainedStockSchema = Schema.TaggedStruct('INSUFFICIENT', {
  availableQuantity: StockQuantitySchema,
  positionRef: StockPositionRefSchema,
  requestedQuantity: StockQuantitySchema,
}).check(
  Schema.makeFilter(({ availableQuantity, positionRef, requestedQuantity }) => {
    if (
      !sameResourceRef(availableQuantity.unitRef, requestedQuantity.unitRef) ||
      positionRef.tenantId !== availableQuantity.unitRef.tenantId
    ) {
      return 'Known constrained insufficiency must preserve one exact Position Tenant and unchanged Unit';
    }
    return compareExactStockQuantityAmounts(availableQuantity.amount, requestedQuantity.amount) < 0
      ? undefined
      : 'Known constrained insufficiency requires available Quantity to be lower than requested Quantity';
  }),
);

export const ConflictingStockEvidenceSchema = Schema.TaggedStruct('CONFLICTING', {
  conflictRef: InventorySourceConflictRefSchema,
  positionRef: StockPositionRefSchema,
  reconciliationRequired: Schema.Literal(true),
}).check(
  Schema.makeFilter(({ conflictRef, positionRef }) =>
    conflictRef.tenantId === positionRef.tenantId
      ? undefined
      : 'Conflicting Stock Evidence and its constrained Position must share one Tenant',
  ),
);

export const InventoryStockEvidenceCapabilityOutcomeSchema = Schema.Union([
  CurrentOnHandEvidenceSchema,
  KnownInsufficientConstrainedStockSchema,
  UnknownOnHandEvidenceSchema,
  MissingOnHandEvidenceSchema,
  StaleOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  ConflictingStockEvidenceSchema,
]);
export type InventoryStockEvidenceCapabilityOutcome = typeof InventoryStockEvidenceCapabilityOutcomeSchema.Type;

type InventoryStockEvidenceTag = InventoryStockEvidenceCapabilityOutcome['_tag'];

export const inventoryStockEvidenceNextStep = (outcome: InventoryStockEvidenceTag) => {
  if (outcome === 'CURRENT') {
    return 'CONTINUE' as const;
  }
  if (outcome === 'INSUFFICIENT') {
    return 'STOP' as const;
  }
  if (outcome === 'CONFLICTING' || outcome === 'INDETERMINATE') {
    return 'RECONCILE' as const;
  }
  return 'ACQUIRE_OWNER_EVIDENCE' as const;
};

/** Source Coverage uses its own outcome vocabulary instead of reusing Stock Evidence tags. */
const InventorySourceCoverageCapabilityOutcomeSchema = InventorySourceAssertionEvaluationSchema;
type InventorySourceCoverageCapabilityOutcome = typeof InventorySourceCoverageCapabilityOutcomeSchema.Type;

export const inventorySourceCoverageNextStep = (outcome: InventorySourceCoverageCapabilityOutcome['_tag']) => {
  if (outcome === 'DETERMINATE') {
    return 'CONTINUE' as const;
  }
  return outcome === 'INDETERMINATE' ? ('RECONCILE' as const) : ('STOP' as const);
};

/** Backend selection never turns a conflict or outage into an implicit fallback. */
const InventoryBackendSelectionCapabilityOutcomeSchema = Schema.Union([
  SelectInventoryBackendResultSchema,
  SelectInventoryBackendErrorSchema,
  ActionPermissionDenied,
]);
type InventoryBackendSelectionCapabilityOutcome = typeof InventoryBackendSelectionCapabilityOutcomeSchema.Type;

export const inventoryBackendSelectionNextStep = (
  outcome: Extract<InventoryBackendSelectionCapabilityOutcome, { readonly outcome: string }>['outcome'],
) => (outcome === 'BACKEND_CONFIGURATION_CONFLICT' ? ('REPAIR_CONFIGURATION' as const) : ('CONTINUE' as const));

/**
 * Reservation establishment retains domain, runtime permission, authority availability, and effect-truth
 * distinctions. There is deliberately no global Inventory outcome enum.
 */
export const InventoryReservationCreateCapabilityOutcomeSchema = Schema.Union([
  CreateInventoryReservationResultSchema,
  CreateInventoryReservationErrorSchema,
  ReservationAuthorityUnavailable,
  ReservationEffectIndeterminate,
  ActionPermissionDenied,
]);

const ReservationCreateNextStepInputSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals([
      'PENDING',
      'ESTABLISHED',
      'EXACT_REPLAY',
      'RECONCILIATION_REQUIRED',
      'INDETERMINATE',
      'RESOLVED_NO_RESERVATION',
    ]),
  }),
  Schema.TaggedStruct('ActionPermissionDenied', {}),
  Schema.TaggedStruct('CatalogToStockBindingResolutionFailure', {}),
  Schema.TaggedStruct('InventoryReservationCreateRejected', { reason: Schema.String }),
  Schema.TaggedStruct('InventoryReservationCreateUnavailable', {}),
  Schema.TaggedStruct('InventoryReservationGuaranteeUnsupported', {}),
  Schema.TaggedStruct('ReservationAuthorityUnavailable', {}),
  Schema.TaggedStruct('ReservationEffectIndeterminate', {}),
]);
type ReservationCreateNextStepInput = typeof ReservationCreateNextStepInputSchema.Type;

const inventoryReservationCreateRejectionNextStep = (reason: string) => {
  if (reason === 'AUTHORITY_NOT_SELECTED') {
    return 'REPAIR_CONFIGURATION' as const;
  }
  if (reason === 'TENANT_SCOPE_MISMATCH' || reason === 'COMMERCE_CONTEXT_NOT_ELIGIBLE') {
    return 'REPAIR_INPUT' as const;
  }
  if (reason === 'ATTEMPT_HAS_UNRESOLVED_EFFECT') {
    return 'RECOVER_ORIGINAL_EFFECT' as const;
  }
  if (reason === 'INVALID_BACKEND_OBSERVATION') {
    return 'RECONCILE' as const;
  }
  return reason === 'EFFECT_ID_CONFLICT' || reason === 'ATTEMPT_ALREADY_BOUND'
    ? ('STOP_CONFLICT' as const)
    : ('STOP' as const);
};

export const inventoryReservationCreateNextStep = (outcome: ReservationCreateNextStepInput) =>
  Match.value(outcome).pipe(
    Match.when({ outcome: 'ESTABLISHED' }, () => 'CONTINUE' as const),
    Match.when({ outcome: 'EXACT_REPLAY' }, () => 'CONTINUE' as const),
    Match.when({ outcome: 'PENDING' }, () => 'RECOVER_ORIGINAL_EFFECT' as const),
    Match.when({ outcome: 'INDETERMINATE' }, () => 'RECOVER_ORIGINAL_EFFECT' as const),
    Match.when({ outcome: 'RECONCILIATION_REQUIRED' }, () => 'RECONCILE' as const),
    Match.when({ outcome: 'RESOLVED_NO_RESERVATION' }, () => 'STOP' as const),
    Match.when({ _tag: 'CatalogToStockBindingResolutionFailure' }, () => 'REPAIR_BINDING' as const),
    Match.when({ _tag: 'ReservationAuthorityUnavailable' }, () => 'WAIT_FOR_OWNER' as const),
    Match.when({ _tag: 'InventoryReservationCreateUnavailable' }, () => 'WAIT_FOR_OWNER' as const),
    Match.when({ _tag: 'ReservationEffectIndeterminate' }, () => 'RECOVER_ORIGINAL_EFFECT' as const),
    Match.when({ _tag: 'InventoryReservationCreateRejected' }, ({ reason }) =>
      inventoryReservationCreateRejectionNextStep(reason),
    ),
    Match.when({ _tag: 'ActionPermissionDenied' }, () => 'STOP' as const),
    Match.when({ _tag: 'InventoryReservationGuaranteeUnsupported' }, () => 'STOP' as const),
    Match.exhaustive,
  );

const InventoryReservationConfirmationCapabilityOutcomeSchema = Schema.Union([
  ReservationConfirmationSchema,
  ReservationConfirmationRejected,
  ReservationConfirmationUnavailable,
  ActionPermissionDenied,
]);
type InventoryReservationConfirmationCapabilityOutcome =
  typeof InventoryReservationConfirmationCapabilityOutcomeSchema.Type;
type ConfirmedReservation = Extract<InventoryReservationConfirmationCapabilityOutcome, { readonly health: unknown }>;

export const inventoryReservationConfirmationNextStep = (health: ConfirmedReservation['health']['state']) => {
  if (health === 'VALID') {
    return 'CONTINUE_TO_PROTECTION' as const;
  }
  if (health === 'AT_RISK') {
    return 'RECONCILE' as const;
  }
  return health === 'UNVERIFIABLE' ? ('ACQUIRE_OWNER_EVIDENCE' as const) : ('STOP' as const);
};

const InventoryReservationShortageCapabilityOutcomeSchema = ReservationShortageImpactEvaluationSchema;
type InventoryReservationShortageCapabilityOutcome = typeof InventoryReservationShortageCapabilityOutcomeSchema.Type;

const ReservationShortageNextStepInputSchema = Schema.Union([
  Schema.TaggedStruct('DETERMINATE', {
    decisions: Schema.Array(Schema.Struct({ capacity: Schema.Literals(['HONORABLE', 'SHORTAGE']) })),
  }),
  Schema.TaggedStruct('INDETERMINATE', {}),
]);
type ReservationShortageNextStepInput = typeof ReservationShortageNextStepInputSchema.Type &
  Pick<InventoryReservationShortageCapabilityOutcome, '_tag'>;

export const inventoryReservationShortageNextStep = (outcome: ReservationShortageNextStepInput) =>
  Match.value(outcome).pipe(
    Match.tag('DETERMINATE', ({ decisions }) =>
      decisions.some(({ capacity }) => capacity === 'SHORTAGE') ? ('STOP' as const) : ('CONTINUE' as const),
    ),
    Match.tag('INDETERMINATE', () => 'RECONCILE' as const),
    Match.exhaustive,
  );

export const inventoryUnresolvedReservationEffectConstraintNextStep = (outcome: 'EXACT' | 'INDETERMINATE') =>
  outcome === 'EXACT' ? ('EVALUATE_COMPENSATION' as const) : ('ACQUIRE_OWNER_EVIDENCE' as const);

export const InventoryCommitmentProtectionCapabilityOutcomeSchema = Schema.Union([
  EstablishCommitmentProtectionResultSchema,
  EstablishCommitmentProtectionErrorSchema,
  ActionPermissionDenied,
]);
const CommitmentProtectionNextStepInputSchema = Schema.Union([
  Schema.TaggedStruct('PROTECTED', {}),
  Schema.TaggedStruct('AT_RISK', {}),
  Schema.TaggedStruct('INDETERMINATE', {}),
  Schema.TaggedStruct('NOT_PROTECTABLE', {}),
  Schema.TaggedStruct('CommitmentProtectionRejected', {}),
  Schema.TaggedStruct('CommitmentProtectionConflict', {}),
  Schema.TaggedStruct('CommitmentProtectionUnavailable', {}),
  Schema.TaggedStruct('ActionPermissionDenied', {}),
]);
type CommitmentProtectionNextStepInput = typeof CommitmentProtectionNextStepInputSchema.Type;

export const inventoryCommitmentProtectionNextStep = (outcome: CommitmentProtectionNextStepInput) =>
  Match.value(outcome).pipe(
    Match.tag('PROTECTED', () => 'CONTINUE' as const),
    Match.tag('AT_RISK', () => 'RECONCILE' as const),
    Match.tag('INDETERMINATE', () => 'RECOVER_ORIGINAL_EFFECT' as const),
    Match.tag('NOT_PROTECTABLE', () => 'STOP' as const),
    Match.tag('CommitmentProtectionRejected', () => 'STOP' as const),
    Match.tag('CommitmentProtectionConflict', () => 'STOP_CONFLICT' as const),
    Match.tag('CommitmentProtectionUnavailable', () => 'WAIT_FOR_OWNER' as const),
    Match.tag('ActionPermissionDenied', () => 'STOP' as const),
    Match.exhaustive,
  );

const InventoryReservationReleaseCapabilityOutcomeSchema = Schema.Union([
  ReleaseInventoryReservationResultSchema,
  ReleaseInventoryReservationErrorSchema,
  ActionPermissionDenied,
]);
type InventoryReservationReleaseCapabilityOutcome = typeof InventoryReservationReleaseCapabilityOutcomeSchema.Type;

interface ReservationReleaseDiscriminant {
  readonly outcome: Extract<InventoryReservationReleaseCapabilityOutcome, { readonly outcome: string }>['outcome'];
}

export const inventoryReservationReleaseNextStep = (outcome: ReservationReleaseDiscriminant) => {
  if (outcome.outcome === 'RELEASED' || outcome.outcome === 'ALREADY_RELEASED') {
    return 'CONTINUE' as const;
  }
  return outcome.outcome === 'PENDING' || outcome.outcome === 'INDETERMINATE'
    ? ('RECOVER_ORIGINAL_EFFECT' as const)
    : ('STOP' as const);
};

const InventoryPreCommitCompensationCapabilityOutcomeSchema = Schema.Union([
  CompensateInventoryPreCommitResultSchema,
  CompensateInventoryPreCommitErrorSchema,
  ActionPermissionDenied,
]);
type InventoryPreCommitCompensationCapabilityOutcome =
  typeof InventoryPreCommitCompensationCapabilityOutcomeSchema.Type;
type InventoryPreCommitCompensationResultOutcome = Extract<
  InventoryPreCommitCompensationCapabilityOutcome,
  { readonly outcome: string }
>['outcome'];

type PreCommitCompensationDiscriminant = (
  | {
      readonly outcome:
        | 'CREATE_EFFECT_COMPENSATED'
        | 'ALREADY_COMPENSATED'
        | 'NO_COMPENSATION_REQUIRED'
        | 'RECONCILIATION_REQUIRED';
    }
  | {
      readonly outcome: 'RESERVATION_RELEASE';
      readonly release: ReservationReleaseDiscriminant;
    }
  | {
      readonly outcome: 'BLOCKED';
      readonly reason: 'ORDER_COMMITTED' | 'ATTEMPT_NOT_CLOSED' | 'ORDER_TRUTH_UNKNOWN';
    }
) & { readonly outcome: InventoryPreCommitCompensationResultOutcome };

export const inventoryPreCommitCompensationNextStep = (outcome: PreCommitCompensationDiscriminant) => {
  if (outcome.outcome === 'RECONCILIATION_REQUIRED') {
    return 'RECONCILE' as const;
  }
  if (outcome.outcome === 'RESERVATION_RELEASE') {
    return inventoryReservationReleaseNextStep(outcome.release);
  }
  if (outcome.outcome !== 'BLOCKED') {
    return 'CONTINUE' as const;
  }
  if (outcome.reason === 'ATTEMPT_NOT_CLOSED') {
    return 'WAIT_FOR_CLOSURE' as const;
  }
  return outcome.reason === 'ORDER_TRUTH_UNKNOWN' ? ('ACQUIRE_OWNER_EVIDENCE' as const) : ('STOP' as const);
};

export const InventoryCommittedObligationCapabilityOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('COMMITTED_OBLIGATION', {
    obligation: RuntimeCommittedInventoryObligationSchema,
  }),
  Schema.TaggedStruct('POST_COMMIT_RECONCILIATION', {
    obligation: RuntimeCommittedInventoryObligationSchema,
    reason: Schema.Literal('POST_COMMIT_BINDING_MISMATCH'),
    reconciliationRequired: Schema.Literal(true),
  }),
]);
export const inventoryCommittedObligationNextStep = (outcome: 'COMMITTED_OBLIGATION' | 'POST_COMMIT_RECONCILIATION') =>
  outcome === 'COMMITTED_OBLIGATION' ? ('CONTINUE' as const) : ('RECONCILE' as const);
