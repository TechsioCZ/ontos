import { Data, DateTime, Schema } from 'effect';

import type {
  PaymentProviderReplayAssessment,
  PaymentProviderReplayGuarantee,
  PaymentRecoveryTrigger,
} from '../../shared/domain/evidence-contract.ts';
import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type {
  PaymentExecutionBinding,
  PaymentGatewayAccountBinding,
} from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import type {
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentRecoveryMode,
} from '../../shared/domain/payment-vocabulary.ts';
import type { OutboxPayload as RecoveryRequested } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import type { PaymentOwnerScope } from '../ports/owner-evidence-unavailable.ts';
import { isDefinitiveOutcome } from './operation-lifecycle.ts';

/**
 * Same-operation recovery planning (#1151 "Idempotency and monetary recovery"). Pure: the caller
 * supplies the original operation, qualified C17 dispatch evidence, and the actual time after the
 * Payment row lock. Recovery retains the same operation and provider binding.
 */

/** Strongest first: a caller may ask for a weaker mode, never a stronger one than evidence permits. */
const MODE_STRENGTH: Readonly<Record<PaymentRecoveryMode, number>> = Object.freeze({
  AUTHORITATIVE_LOOKUP: 1,
  AWAIT_QUALIFIED_EVIDENCE: 2,
  GOVERNED_RECONCILIATION: 3,
  PROVIDER_IDEMPOTENT_REPLAY: 0,
});

export interface PaymentRecoveryOperationView {
  readonly binding: PaymentExecutionBinding;
  readonly createdAt: DateTime.Utc;
  readonly kind: PaymentOperationKind;
  readonly materialHash: string;
  readonly operationId: string;
  readonly outcome: PaymentOperationOutcome;
  readonly paymentId: string;
}

export interface PaymentRecoveryRequestInput {
  readonly guarantee?: PaymentProviderReplayGuarantee | undefined;
  readonly now: DateTime.Utc;
  readonly requestedMode: PaymentRecoveryMode | undefined;
  readonly scope: PaymentOwnerScope;
  readonly trigger: PaymentRecoveryTrigger;
}

export type PaymentRecoveryPlanCase = Data.TaggedEnum<{
  /** The operation is definitive: there is nothing to recover. */
  AlreadyResolved: { readonly outcome: PaymentOperationOutcome };
  Plan: {
    /** An executor task (Outbox) is admitted only for replay or lookup work. */
    readonly executorWork: boolean;
    /** Explicit reconciliation debt must be opened (held), never a fabricated outcome. */
    readonly hold: boolean;
    /** Transport loss or an overdue gateway callback makes a PENDING request INDETERMINATE (never NOT_EFFECTED). */
    readonly markIndeterminate: boolean;
    readonly mode: PaymentRecoveryMode;
    readonly modeDowngraded: boolean;
    readonly providerReplay: PaymentProviderReplayAssessment;
  };
}>;
export const PaymentRecoveryPlan = Data.taggedEnum<PaymentRecoveryPlanCase>();

const isGatewayBinding = Schema.is(PaymentGatewayAccountBindingSchema);

const sameGatewayBinding = (left: PaymentGatewayAccountBinding, right: PaymentGatewayAccountBinding) =>
  left.providerFamily === right.providerFamily &&
  left.providerAccountRef === right.providerAccountRef &&
  left.environment === right.environment;

type RecoveryTarget = Pick<
  PaymentRecoveryOperationView,
  'binding' | 'kind' | 'materialHash' | 'operationId' | 'paymentId'
>;

const guaranteeMatchesTarget = (
  guarantee: PaymentProviderReplayGuarantee,
  target: RecoveryTarget,
  scope: PaymentOwnerScope,
) =>
  isGatewayBinding(target.binding) &&
  sameGatewayBinding(guarantee.binding, target.binding) &&
  guarantee.tenantId === scope.tenantId &&
  guarantee.legalEntityId === scope.legalEntityId &&
  guarantee.paymentId === target.paymentId &&
  guarantee.operationId === target.operationId &&
  guarantee.operationKind === target.kind &&
  guarantee.materialHash === target.materialHash;

const assessGuaranteeWindow = (
  guarantee: PaymentProviderReplayGuarantee,
  now: DateTime.Utc,
): PaymentProviderReplayAssessment => {
  const time = DateTime.toEpochMillis(now);
  if (guarantee.startsAtEpochMs >= guarantee.expiresAtEpochMs || time < guarantee.startsAtEpochMs) {
    return 'NOT_PROVEN';
  }
  return time < guarantee.expiresAtEpochMs ? 'COVERS_NOW' : 'EXPIRED';
};

/** Checks the original provider dispatch evidence against the admitted operation and actual time. */
export const assessProviderReplay = (
  operation: PaymentRecoveryOperationView,
  request: Pick<PaymentRecoveryRequestInput, 'guarantee' | 'now' | 'scope'>,
): PaymentProviderReplayAssessment => {
  if (!isGatewayBinding(operation.binding)) {
    return 'NOT_APPLICABLE';
  }
  const { guarantee, now, scope } = request;
  if (
    guarantee === undefined ||
    !guaranteeMatchesTarget(guarantee, operation, scope) ||
    guarantee.startsAtEpochMs < DateTime.toEpochMillis(operation.createdAt)
  ) {
    return 'NOT_PROVEN';
  }
  return assessGuaranteeWindow(guarantee, now);
};

const sameProviderDispatch = (queued: PaymentProviderReplayGuarantee, retained: PaymentProviderReplayGuarantee) =>
  queued.endpointRef === retained.endpointRef &&
  queued.providerRequestHash === retained.providerRequestHash &&
  queued.providerIdempotencyKeyHash === retained.providerIdempotencyKeyHash &&
  queued.startsAtEpochMs === retained.startsAtEpochMs &&
  queued.expiresAtEpochMs === retained.expiresAtEpochMs;

type CurrentRecoveryOperation = PaymentRecoveryOperationView & {
  readonly provenance: PaymentExecutionProvenance;
};

const sameRecoveryLineage = (message: RecoveryRequested, current: CurrentRecoveryOperation) =>
  message.operationId === current.operationId &&
  message.paymentId === current.paymentId &&
  message.operationKind === current.kind &&
  message.materialHash === current.materialHash &&
  message.originalCompositionRevision === current.provenance.compositionRevision &&
  message.originalActionInvocationId === current.provenance.actionInvocationId &&
  isGatewayBinding(message.binding) &&
  isGatewayBinding(current.binding) &&
  sameGatewayBinding(message.binding, current.binding);

/**
 * C17 supplies the governed Current operation and its retained dispatch immediately before a send.
 * A queue delay, legacy message, changed request, or missing proof leaves authoritative lookup.
 */
export const paymentRecoveryModeAtDispatch = (
  message: RecoveryRequested,
  current: CurrentRecoveryOperation,
  scope: PaymentOwnerScope,
  now: DateTime.Utc,
  retained: PaymentProviderReplayGuarantee | undefined,
): PaymentRecoveryMode | 'ALREADY_RESOLVED' => {
  if (!sameRecoveryLineage(message, current) || current.outcome === 'CONFLICT') {
    return 'GOVERNED_RECONCILIATION';
  }
  if (isDefinitiveOutcome(current.outcome)) {
    return 'ALREADY_RESOLVED';
  }
  if (message.mode !== 'PROVIDER_IDEMPOTENT_REPLAY') {
    return message.mode;
  }
  const queued = message.providerReplayGuarantee;
  return queued !== undefined &&
    retained !== undefined &&
    guaranteeMatchesTarget(queued, current, scope) &&
    sameProviderDispatch(queued, retained) &&
    assessProviderReplay(current, { guarantee: retained, now, scope }) === 'COVERS_NOW'
    ? 'PROVIDER_IDEMPOTENT_REPLAY'
    : 'AUTHORITATIVE_LOOKUP';
};

const strongestPermittedMode = (
  operation: PaymentRecoveryOperationView,
  trigger: PaymentRecoveryTrigger,
  providerReplay: PaymentProviderReplayAssessment,
): PaymentRecoveryMode => {
  if (operation.outcome === 'CONFLICT' || trigger === 'LOOKUP_AUTHORITY_UNAVAILABLE') {
    return 'GOVERNED_RECONCILIATION';
  }
  if (providerReplay === 'COVERS_NOW') {
    return 'PROVIDER_IDEMPOTENT_REPLAY';
  }
  return isGatewayBinding(operation.binding) ? 'AUTHORITATIVE_LOOKUP' : 'AWAIT_QUALIFIED_EVIDENCE';
};

/** Plans recovery of the SAME original operation under its stored binding. */
export const planPaymentRecovery = (
  operation: PaymentRecoveryOperationView,
  request: PaymentRecoveryRequestInput,
): PaymentRecoveryPlanCase => {
  if (isDefinitiveOutcome(operation.outcome)) {
    return PaymentRecoveryPlan.AlreadyResolved({ outcome: operation.outcome });
  }
  const providerReplay = assessProviderReplay(operation, request);
  const permitted = strongestPermittedMode(operation, request.trigger, providerReplay);
  const requested = request.requestedMode ?? permitted;
  const modeDowngraded = MODE_STRENGTH[requested] < MODE_STRENGTH[permitted];
  const mode = modeDowngraded ? permitted : requested;
  return PaymentRecoveryPlan.Plan({
    executorWork: mode === 'PROVIDER_IDEMPOTENT_REPLAY' || mode === 'AUTHORITATIVE_LOOKUP',
    hold: mode === 'GOVERNED_RECONCILIATION',
    markIndeterminate:
      operation.outcome === 'PENDING' &&
      (request.trigger === 'EXECUTION_OUTCOME_UNKNOWN' ||
        (request.trigger === 'OUTCOME_OVERDUE' && isGatewayBinding(operation.binding))),
    mode,
    modeDowngraded,
    providerReplay,
  });
};
