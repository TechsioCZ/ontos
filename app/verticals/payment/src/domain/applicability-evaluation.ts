import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Effect, Match, Option, Result } from 'effect';

import type {
  PaymentApplicabilityCheck,
  PaymentApplicabilityFinding,
  PaymentApplicabilityReason,
  PaymentApplicabilityTermEvidence,
  PaymentMethodBranchApplicability,
  PaymentMethodBranchSelection,
  PaymentMethodEnablementState,
  PaymentNotAvailableApplicabilityOutcome,
} from '../../shared/domain/applicability-contract.ts';
import type {
  PaymentExecutionBinding,
  PaymentGatewayAccountBinding,
} from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { DeliveryCapabilityPort } from '../ports/delivery-capability-port.ts';
import type { PaymentCodCapability } from '../ports/delivery-capability-port.ts';
import { GatewayBindingPort } from '../ports/gateway-binding-port.ts';
import type { PaymentGatewayBindingVerification } from '../ports/gateway-binding-port.ts';
import type { PaymentOwnerScope } from '../ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort } from '../ports/payment-term-evidence-port.ts';
import type { PaymentTermUseEvidence } from '../ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../ports/pickup-capability-port.ts';
import type { PaymentPickupCollectionCapability } from '../ports/pickup-capability-port.ts';

/**
 * Per-branch Payment Method applicability (#1147, H1094-01=A).
 *
 * Every branch is decided only on its own required evidence: the common purchase/term evidence for
 * that method, the merchant enablement of that method, and the method-specific owner fact (explicit
 * gateway binding, exact Delivery Offer COD capability or exact pickup capability). An outage of one
 * branch's evidence yields `UNAVAILABLE_TO_VERIFY` for that branch only; it never becomes absence,
 * `NOT_ENABLED` or a negative fact, and no other branch is selected in its place. The evaluation is
 * side-effect free; it reads owner ports and the Current enablement rows the caller loaded.
 */

export interface PaymentMethodApplicabilityInput {
  /** Exact authoritative Purchase Payable Amount; Payment never recomputes it. */
  readonly amount: PaymentMonetaryAmount;
  readonly customerConfigurationId: string;
  /** Current enablement rows of this Customer Configuration in the Selling Legal Entity (A1). */
  readonly enablements: readonly PaymentMethodEnablementState[];
  /** The resolved term; it is returned unchanged on AVAILABLE and never replaced by method choice. */
  readonly paymentTermRef: PaymentTermRef;
  /** Trusted Core scope; never taken from the payload. */
  readonly scope: PaymentOwnerScope;
  /** The exact branches to evaluate; results come back in the same order. */
  readonly selections: readonly PaymentMethodBranchSelection[];
}

export type PaymentMethodApplicabilityRequirements =
  | DeliveryCapabilityPort
  | GatewayBindingPort
  | PaymentTermEvidencePort
  | PickupCapabilityPort;

/** At most one branch per Launch method, and two independent owner checks per branch. */
const BRANCH_CONCURRENCY = 5;
const BRANCH_EVIDENCE_CONCURRENCY = 2;

type Findings = readonly [PaymentApplicabilityFinding, ...PaymentApplicabilityFinding[]];
type CheckResult<Value> = Result.Result<Value, Findings>;

const failed = (
  check: PaymentApplicabilityCheck,
  outcome: PaymentNotAvailableApplicabilityOutcome,
  reason: PaymentApplicabilityReason,
): CheckResult<never> => Result.fail([{ check, outcome, reason }]);
const unavailableToVerify = (check: PaymentApplicabilityCheck) =>
  failed(check, 'UNAVAILABLE_TO_VERIFY', 'EVIDENCE_UNAVAILABLE');
const subjectMismatch = (check: PaymentApplicabilityCheck) =>
  failed(check, 'CONFLICTING_CONFIGURATION', 'EVIDENCE_SUBJECT_MISMATCH');
const selectionMissing = failed('METHOD_SELECTION', 'MISSING_REQUIRED_INPUT', 'SELECTION_MISSING');

const findingsOf = <Value>(result: CheckResult<Value>): readonly PaymentApplicabilityFinding[] =>
  Option.getOrElse(Result.getFailure(result), () => []);

/** Both checks must pass; every failing check contributes its findings. */
const zip = <Left, Right>(left: CheckResult<Left>, right: CheckResult<Right>): CheckResult<readonly [Left, Right]> =>
  Result.match(left, {
    onFailure: (leftFindings) => Result.fail([...leftFindings, ...findingsOf(right)]),
    onSuccess: (leftValue) =>
      Result.match(right, {
        onFailure: (rightFindings): CheckResult<readonly [Left, Right]> => Result.fail(rightFindings),
        onSuccess: (rightValue) => Result.succeed([leftValue, rightValue] as const),
      }),
  });

/**
 * When several required checks fail, a definitive owner fact that rules the branch out is reported
 * ahead of an inconsistency, and an inconsistency ahead of an outage. All findings are returned.
 */
const OUTCOME_PRECEDENCE: readonly PaymentNotAvailableApplicabilityOutcome[] = [
  'NOT_ENABLED',
  'MISSING_REQUIRED_INPUT',
  'INCOMPATIBLE_TERM',
  'UNSUPPORTED_CAPABILITY',
  'CONFLICTING_CONFIGURATION',
  'UNAVAILABLE_TO_VERIFY',
];

const notAvailable = (method: PaymentMethod, findings: Findings): PaymentMethodBranchApplicability => ({
  findings,
  method,
  outcome:
    OUTCOME_PRECEDENCE.find((candidate) => findings.some((finding) => finding.outcome === candidate)) ??
    findings[0].outcome,
});

const sameTermRef = (left: PaymentTermRef, right: PaymentTermRef) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameGatewayBinding = (left: PaymentGatewayAccountBinding, right: PaymentGatewayAccountBinding) =>
  left.providerFamily === right.providerFamily &&
  left.providerAccountRef === right.providerAccountRef &&
  left.environment === right.environment;

/** Owner reasons travel verbatim; the exhaustive maps make a new owner reason a compile error here. */
const TERM_NOT_USABLE_REASON = {
  ENTITLEMENT_NOT_CURRENT: 'ENTITLEMENT_NOT_CURRENT',
  POLICY_DENIED: 'POLICY_DENIED',
  TERM_NOT_FOUND: 'TERM_NOT_FOUND',
  TERM_RETIRED: 'TERM_RETIRED',
  TERM_SEMANTICS_INCOMPATIBLE: 'TERM_SEMANTICS_INCOMPATIBLE',
} as const satisfies Record<
  Extract<PaymentTermUseEvidence, { _tag: 'NOT_USABLE' }>['reason'],
  PaymentApplicabilityReason
>;
const COD_NOT_SUPPORTED_REASON = {
  AMOUNT_OUTSIDE_COD_CONSTRAINTS: 'AMOUNT_OUTSIDE_COD_CONSTRAINTS',
  OFFER_NOT_COD_CAPABLE: 'OFFER_NOT_COD_CAPABLE',
  OFFER_NOT_CURRENT: 'OFFER_NOT_CURRENT',
} as const satisfies Record<
  Extract<PaymentCodCapability, { _tag: 'NOT_SUPPORTED' }>['reason'],
  PaymentApplicabilityReason
>;
const PICKUP_NOT_SUPPORTED_REASON = {
  AMOUNT_OUTSIDE_COLLECTION_CONSTRAINTS: 'AMOUNT_OUTSIDE_COLLECTION_CONSTRAINTS',
  CAPABILITY_NOT_CURRENT: 'CAPABILITY_NOT_CURRENT',
  COLLECTION_NOT_SUPPORTED: 'COLLECTION_NOT_SUPPORTED',
} as const satisfies Record<
  Extract<PaymentPickupCollectionCapability, { _tag: 'NOT_SUPPORTED' }>['reason'],
  PaymentApplicabilityReason
>;

/** Merchant enablement of this exact method (local Current configuration). */
const checkEnablement = (
  enablements: readonly PaymentMethodEnablementState[],
  method: PaymentMethod,
): CheckResult<number> => {
  const rows = enablements.filter((row) => row.method === method);
  const [row] = rows;
  if (row === undefined) {
    return failed('METHOD_ENABLEMENT', 'NOT_ENABLED', 'NOT_CONFIGURED');
  }
  if (rows.length > 1) {
    return failed('METHOD_ENABLEMENT', 'CONFLICTING_CONFIGURATION', 'DUPLICATE_CONFIGURATION');
  }
  return row.enabled ? Result.succeed(row.revision) : failed('METHOD_ENABLEMENT', 'NOT_ENABLED', 'DISABLED');
};

const checkTermScope = (paymentTermRef: PaymentTermRef, scope: PaymentOwnerScope): CheckResult<PaymentTermRef> =>
  paymentTermRef.tenantId === scope.tenantId
    ? Result.succeed(paymentTermRef)
    : failed('PAYMENT_TERM', 'CONFLICTING_CONFIGURATION', 'FOREIGN_TERM_REFERENCE');

/**
 * Interprets the exact C15 semantic snapshot + CCC Current entitlement/policy decision. Only
 * `DEFERRED_INVOICE` needs `NET_DAYS`; any other method keeps a `NET_DAYS` term unchanged (early payment).
 * No invoice issue DATE or due DATE is derived: the reusable condition is all Payment evaluates.
 */
export const interpretTermEvidence = (
  method: PaymentMethod,
  requested: PaymentTermRef,
  evidence: PaymentTermUseEvidence,
): CheckResult<PaymentApplicabilityTermEvidence> => {
  if (!sameTermRef(evidence.paymentTermRef, requested)) {
    return subjectMismatch('PAYMENT_TERM');
  }
  return Match.value(evidence).pipe(
    Match.tagsExhaustive({
      NOT_USABLE: ({ reason }) => failed('PAYMENT_TERM', 'INCOMPATIBLE_TERM', TERM_NOT_USABLE_REASON[reason]),
      USABLE: (usable): CheckResult<PaymentApplicabilityTermEvidence> => {
        if (!sameTermRef(usable.semanticSnapshot.paymentTermRef, requested)) {
          return subjectMismatch('PAYMENT_TERM');
        }
        if (method === 'DEFERRED_INVOICE' && usable.semanticSnapshot.semantics.kind !== 'NET_DAYS') {
          return failed('PAYMENT_TERM', 'INCOMPATIBLE_TERM', 'TERM_NOT_DEFERRABLE');
        }
        return Result.succeed({
          entitlementEvidenceRef: usable.entitlementEvidenceRef,
          paymentTermRef: requested,
          semanticSnapshot: usable.semanticSnapshot,
        });
      },
    }),
  );
};

const checkTerm = Effect.fn('PaymentApplicability.checkTerm')(function* checkTerm(
  input: PaymentMethodApplicabilityInput,
  method: PaymentMethod,
) {
  const terms = yield* PaymentTermEvidencePort;
  return yield* terms
    .verifyTermUse({
      customerConfigurationId: input.customerConfigurationId,
      method,
      paymentTermRef: input.paymentTermRef,
      scope: input.scope,
    })
    .pipe(
      Effect.map((evidence) => interpretTermEvidence(method, input.paymentTermRef, evidence)),
      Effect.catchTag('PaymentOwnerEvidenceUnavailable', () => Effect.succeed(unavailableToVerify('PAYMENT_TERM'))),
    );
});

const interpretGatewayBinding = (
  selected: PaymentGatewayAccountBinding,
  verification: PaymentGatewayBindingVerification,
): CheckResult<PaymentExecutionBinding> =>
  sameGatewayBinding(verification.binding, selected)
    ? Match.value(verification).pipe(
        Match.tagsExhaustive({
          ENABLED: (): CheckResult<PaymentExecutionBinding> => Result.succeed(selected),
          NOT_ENABLED: () => failed('GATEWAY_BINDING', 'NOT_ENABLED', 'BINDING_NOT_ENABLED'),
        }),
      )
    : subjectMismatch('GATEWAY_BINDING');

const interpretCodCapability = (
  deliveryOfferRef: string,
  capability: PaymentCodCapability,
): CheckResult<PaymentExecutionBinding> =>
  capability.deliveryOfferRef === deliveryOfferRef
    ? Match.value(capability).pipe(
        Match.tagsExhaustive({
          NOT_SUPPORTED: ({ reason }) =>
            failed('DELIVERY_CAPABILITY', 'UNSUPPORTED_CAPABILITY', COD_NOT_SUPPORTED_REASON[reason]),
          SUPPORTED: (supported): CheckResult<PaymentExecutionBinding> =>
            Result.succeed({
              _tag: 'COD_DELIVERY_OFFER',
              capabilityEvidenceRef: supported.capabilityEvidenceRef,
              deliveryOfferRef: supported.deliveryOfferRef,
            }),
        }),
      )
    : subjectMismatch('DELIVERY_CAPABILITY');

const interpretPickupCapability = (
  pickupCapabilityRef: string,
  capability: PaymentPickupCollectionCapability,
): CheckResult<PaymentExecutionBinding> =>
  capability.pickupCapabilityRef === pickupCapabilityRef
    ? Match.value(capability).pipe(
        Match.tagsExhaustive({
          NOT_SUPPORTED: ({ reason }) =>
            failed('PICKUP_CAPABILITY', 'UNSUPPORTED_CAPABILITY', PICKUP_NOT_SUPPORTED_REASON[reason]),
          SUPPORTED: (supported): CheckResult<PaymentExecutionBinding> =>
            Result.succeed({
              _tag: 'PICKUP_CAPABILITY',
              capabilityEvidenceRef: supported.capabilityEvidenceRef,
              pickupCapabilityRef: supported.pickupCapabilityRef,
            }),
        }),
      )
    : subjectMismatch('PICKUP_CAPABILITY');

const verifyGateway = Effect.fn('PaymentApplicability.verifyGateway')(function* verifyGateway(
  input: PaymentMethodApplicabilityInput,
  selectedBinding: PaymentGatewayAccountBinding,
) {
  const gateways = yield* GatewayBindingPort;
  return yield* gateways
    .verifySelectedBinding({
      binding: selectedBinding,
      customerConfigurationId: input.customerConfigurationId,
      scope: input.scope,
    })
    .pipe(
      Effect.map((verification) => interpretGatewayBinding(selectedBinding, verification)),
      Effect.catchTag('PaymentOwnerEvidenceUnavailable', () => Effect.succeed(unavailableToVerify('GATEWAY_BINDING'))),
    );
});

const verifyCod = Effect.fn('PaymentApplicability.verifyCod')(function* verifyCod(
  input: PaymentMethodApplicabilityInput,
  deliveryOfferRef: string,
) {
  const delivery = yield* DeliveryCapabilityPort;
  return yield* delivery.verifyCashOnDelivery({ amount: input.amount, deliveryOfferRef, scope: input.scope }).pipe(
    Effect.map((capability) => interpretCodCapability(deliveryOfferRef, capability)),
    Effect.catchTag('PaymentOwnerEvidenceUnavailable', () =>
      Effect.succeed(unavailableToVerify('DELIVERY_CAPABILITY')),
    ),
  );
});

const verifyPickup = Effect.fn('PaymentApplicability.verifyPickup')(function* verifyPickup(
  input: PaymentMethodApplicabilityInput,
  pickupCapabilityRef: string,
) {
  const pickup = yield* PickupCapabilityPort;
  return yield* pickup.verifyPickupCollection({ amount: input.amount, pickupCapabilityRef, scope: input.scope }).pipe(
    Effect.map((capability) => interpretPickupCapability(pickupCapabilityRef, capability)),
    Effect.catchTag('PaymentOwnerEvidenceUnavailable', () => Effect.succeed(unavailableToVerify('PICKUP_CAPABILITY'))),
  );
});

/** Receipt is evidenced later by configured bank/accounting authority (#1152); QR is presentation only. */
const bankAccountingReceipt = Effect.succeed<CheckResult<PaymentExecutionBinding>>(
  Result.succeed({ _tag: 'BANK_ACCOUNTING_RECEIPT' }),
);
const missingSelection = Effect.succeed<CheckResult<PaymentExecutionBinding>>(selectionMissing);

/**
 * The method-specific owner fact for the caller's explicit selection; nothing is ever chosen on its
 * behalf. A missing selection is `MISSING_REQUIRED_INPUT`; an outage stays `UNAVAILABLE_TO_VERIFY`.
 */
const checkExecutionBinding = (input: PaymentMethodApplicabilityInput, selection: PaymentMethodBranchSelection) =>
  Match.value(selection).pipe(
    Match.discriminatorsExhaustive('method')({
      BANK_TRANSFER_ADVANCE: () => bankAccountingReceipt,
      CASH_ON_DELIVERY: ({ deliveryOfferRef }) =>
        deliveryOfferRef === undefined ? missingSelection : verifyCod(input, deliveryOfferRef),
      DEFERRED_INVOICE: () => bankAccountingReceipt,
      ONLINE_GATEWAY: ({ selectedBinding }) =>
        selectedBinding === undefined ? missingSelection : verifyGateway(input, selectedBinding),
      PAY_ON_PICKUP_OR_ON_SITE: ({ pickupCapabilityRef }) =>
        pickupCapabilityRef === undefined ? missingSelection : verifyPickup(input, pickupCapabilityRef),
    }),
  );

/** True when the branch's own method-specific selection was supplied. */
const hasSelection = (selection: PaymentMethodBranchSelection): CheckResult<true> =>
  Match.value(selection).pipe(
    Match.discriminatorsExhaustive('method')({
      BANK_TRANSFER_ADVANCE: () => true,
      CASH_ON_DELIVERY: ({ deliveryOfferRef }) => deliveryOfferRef !== undefined,
      DEFERRED_INVOICE: () => true,
      ONLINE_GATEWAY: ({ selectedBinding }) => selectedBinding !== undefined,
      PAY_ON_PICKUP_OR_ON_SITE: ({ pickupCapabilityRef }) => pickupCapabilityRef !== undefined,
    }),
    (present): CheckResult<true> => (present ? Result.succeed(true) : selectionMissing),
  );

const toBranch = <Value>(
  method: PaymentMethod,
  result: CheckResult<Value>,
  onAvailable: (value: Value) => PaymentMethodBranchApplicability,
): PaymentMethodBranchApplicability =>
  Result.match(result, { onFailure: (findings) => notAvailable(method, findings), onSuccess: onAvailable });

/** Evaluates one branch on its own prerequisites. Never fails: every outcome is a typed branch result. */
export const evaluatePaymentMethodBranch = Effect.fn('PaymentApplicability.evaluateBranch')(function* evaluateBranch(
  input: PaymentMethodApplicabilityInput,
  selection: PaymentMethodBranchSelection,
) {
  const { method } = selection;
  // Local Current facts first: a method that is not offered or not fully selected needs no owner call.
  const local = zip(
    zip(hasSelection(selection), checkEnablement(input.enablements, method)),
    checkTermScope(input.paymentTermRef, input.scope),
  );
  if (Result.isFailure(local)) {
    return notAvailable(method, local.failure);
  }
  const [[, enablementRevision]] = local.success;
  const [term, binding] = yield* Effect.all([checkTerm(input, method), checkExecutionBinding(input, selection)], {
    concurrency: BRANCH_EVIDENCE_CONCURRENCY,
  });
  return toBranch(method, zip(term, binding), ([termEvidence, executionBinding]) => ({
    enablementRevision,
    executionBinding,
    method,
    outcome: 'AVAILABLE',
    term: termEvidence,
  }));
});

/**
 * Evaluates every requested branch independently (#1147). The result has one typed outcome per
 * branch in request order; nothing is selected, defaulted or substituted. L2 `create-payment` calls
 * this with a single selection and the same inputs before it records a Payment intent.
 */
export const evaluatePaymentMethodApplicability = (
  input: PaymentMethodApplicabilityInput,
): Effect.Effect<readonly PaymentMethodBranchApplicability[], never, PaymentMethodApplicabilityRequirements> =>
  Effect.forEach(input.selections, (selection) => evaluatePaymentMethodBranch(input, selection), {
    concurrency: BRANCH_CONCURRENCY,
  });
