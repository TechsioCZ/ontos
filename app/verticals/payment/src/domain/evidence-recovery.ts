import { Data, DateTime, Option, Schema } from 'effect';

import { PaymentOperationIdempotencyMaterialSchema } from '../../shared/domain/evidence-contract.ts';
import type {
  PaymentProviderIdempotencyGuarantee,
  PaymentProviderReplayAssessment,
  PaymentRecoveryTrigger,
} from '../../shared/domain/evidence-contract.ts';
import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type {
  PaymentExecutionBinding,
  PaymentGatewayAccountBinding,
} from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentOperationOutcome, PaymentRecoveryMode } from '../../shared/domain/payment-vocabulary.ts';
import { isDefinitiveOutcome } from './operation-lifecycle.ts';

/**
 * Same-operation recovery planning (#1151 "Idempotency and monetary recovery"). Pure: the caller
 * supplies the ORIGINAL stored operation (binding, material request, admission time) and the actual
 * time read after the Payment row lock. Recovery never creates an operation, never switches account,
 * environment or provider, and never proves non-execution.
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
  /** Admission time of the operation; the conservative start of any provider guarantee window. */
  readonly createdAt: DateTime.Utc;
  readonly materialRequest: Schema.Json;
  readonly outcome: PaymentOperationOutcome;
}

export interface PaymentRecoveryRequestInput {
  readonly now: DateTime.Utc;
  readonly requestedMode: PaymentRecoveryMode | undefined;
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
    /** Transport loss of a PENDING request makes it INDETERMINATE (never NOT_EFFECTED). */
    readonly markIndeterminate: boolean;
    readonly mode: PaymentRecoveryMode;
    readonly modeDowngraded: boolean;
    readonly providerReplay: PaymentProviderReplayAssessment;
  };
}>;
export const PaymentRecoveryPlan = Data.taggedEnum<PaymentRecoveryPlanCase>();

const isGatewayBinding = Schema.is(PaymentGatewayAccountBindingSchema);

const decodeGuarantee = Schema.decodeUnknownOption(PaymentOperationIdempotencyMaterialSchema);

const guaranteeMatchesBinding = (
  guarantee: PaymentProviderIdempotencyGuarantee,
  binding: PaymentGatewayAccountBinding,
) =>
  guarantee.providerFamily === binding.providerFamily &&
  guarantee.providerAccountRef === binding.providerAccountRef &&
  guarantee.environment === binding.environment;

/** Does the stored binding prove a provider idempotency guarantee whose window still covers `now`? */
export const assessProviderReplay = (
  operation: PaymentRecoveryOperationView,
  now: DateTime.Utc,
): PaymentProviderReplayAssessment => {
  const { binding } = operation;
  if (!isGatewayBinding(binding)) {
    return 'NOT_APPLICABLE';
  }
  const guarantee = Option.map(decodeGuarantee(operation.materialRequest), (material) => material.providerIdempotency);
  if (Option.isNone(guarantee) || !guaranteeMatchesBinding(guarantee.value, binding)) {
    return 'NOT_PROVEN';
  }
  const windowEnd = DateTime.add(operation.createdAt, { seconds: guarantee.value.windowSeconds });
  return DateTime.isLessThan(now, windowEnd) ? 'COVERS_NOW' : 'EXPIRED';
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
  const providerReplay = assessProviderReplay(operation, request.now);
  const permitted = strongestPermittedMode(operation, request.trigger, providerReplay);
  const requested = request.requestedMode ?? permitted;
  const modeDowngraded = MODE_STRENGTH[requested] < MODE_STRENGTH[permitted];
  const mode = modeDowngraded ? permitted : requested;
  return PaymentRecoveryPlan.Plan({
    executorWork: mode === 'PROVIDER_IDEMPOTENT_REPLAY' || mode === 'AUTHORITATIVE_LOOKUP',
    hold: mode === 'GOVERNED_RECONCILIATION',
    markIndeterminate: request.trigger === 'EXECUTION_OUTCOME_UNKNOWN' && operation.outcome === 'PENDING',
    mode,
    modeDowngraded,
    providerReplay,
  });
};
