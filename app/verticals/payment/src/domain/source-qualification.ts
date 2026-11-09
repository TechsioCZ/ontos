import { Data, DateTime, Match, Option } from 'effect';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PAYMENT_LAUNCH_CURRENCY } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type {
  PaymentMethod,
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentSourceAuthorityStatus,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import type {
  PaymentSourceBinding,
  PaymentSourceClaimedAmount,
  PaymentSourceEntry,
} from '../../shared/domain/source-statement.ts';
import { codCarrierBindingProblem } from './cod-carrier.ts';
import type { QualifiedPaymentObservation } from './evidence-interpretation.ts';
import { paymentFactMeaning } from './evidence-interpretation.ts';

/**
 * Exact external/offline source qualification (#1152 "Authority by fact family", "Qualified source
 * statement contract"; ingress half of #1151). Pure: it decides only from the configured authorities,
 * the Current Payment aggregate and the recorded observations loaded under the owner locks.
 *
 * - Authority is per exact fact family and configured source binding; there is no global precedence
 *   ("ERP wins") and a transport, a credential or a gateway assertion is never authority by itself.
 * - Only a principal bound to the authority (#1153 "Integration/provider principals submit only their
 *   configured fact families/source bindings") speaks as it. The submitting principal is the trusted
 *   Core invocation principal, never a payload claim; holding the Action permission is not enough.
 * - Tenant and Selling Legal Entity come only from the trusted operation scope: a statement from a
 *   foreign scope finds neither the authority nor the Payment, and never mutates it.
 * - Same amount, variable symbol or reference never correlate; only the exact Payment identity, the
 *   original execution binding and the selected capability do.
 * - A generic carrier DELIVERED signal is not customer-funds collection: only a carrier authority
 *   configured for COD_CUSTOMER_COLLECTION stating COLLECTION_CONFIRMED for the exact Delivery Offer is.
 * - Operator/POS and manual refund statements enter only through the separately permitted local
 *   evidence Action; a manual refund route can report a request, never confirm returned money.
 */

const ENTRY_SOURCE_KINDS: Readonly<Record<PaymentSourceEntry, readonly PaymentSourceKind[]>> = Object.freeze({
  INTEGRATION: ['BANK_ACCOUNTING', 'CARRIER', 'PAYMENT_GATEWAY'],
  LOCAL_EVIDENCE: ['LOCAL_POS_OPERATOR', 'MANUAL_EXTERNAL_REFUND'],
});

interface SourceFactAuthority {
  readonly facts: readonly PaymentObservationFactKind[];
  readonly methods: readonly PaymentMethod[];
}

const NON_GATEWAY_METHODS = [
  'BANK_TRANSFER_ADVANCE',
  'DEFERRED_INVOICE',
  'CASH_ON_DELIVERY',
  'PAY_ON_PICKUP_OR_ON_SITE',
] as const satisfies readonly PaymentMethod[];
const RECEIPT_FACTS = [
  'COLLECTION_CONFIRMED',
  'SOURCE_CORRECTION',
] as const satisfies readonly PaymentObservationFactKind[];
const HANDOVER_FACTS = [
  'COLLECTION_CONFIRMED',
  'COLLECTION_NOT_EFFECTED',
  'SOURCE_CORRECTION',
] as const satisfies readonly PaymentObservationFactKind[];
const REMITTANCE_FACTS = [
  'SETTLEMENT_OBSERVED',
  'SOURCE_CORRECTION',
] as const satisfies readonly PaymentObservationFactKind[];
const REFUND_EFFECT_FACTS = [
  'REFUND_PENDING',
  'REFUND_CONFIRMED',
  'REFUND_NOT_EFFECTED',
  'SOURCE_CORRECTION',
] as const satisfies readonly PaymentObservationFactKind[];

/**
 * The exact authority matrix (#1152 tables "Authority by fact family" and "Non-gateway refund execution
 * authority"): which source kinds may be configured for a fact family, for which methods, and which
 * canonical facts they can establish. Anything absent is unauthorized or unsupported.
 */
export const PAYMENT_SOURCE_FACT_AUTHORITY: Readonly<
  Record<PaymentSourceFactFamily, Readonly<Partial<Record<PaymentSourceKind, SourceFactAuthority>>>>
> = Object.freeze({
  BANK_ACCOUNTING_RECEIPT: { BANK_ACCOUNTING: { facts: RECEIPT_FACTS, methods: ['BANK_TRANSFER_ADVANCE'] } },
  COD_CUSTOMER_COLLECTION: { CARRIER: { facts: HANDOVER_FACTS, methods: ['CASH_ON_DELIVERY'] } },
  COD_REMITTANCE: {
    BANK_ACCOUNTING: { facts: REMITTANCE_FACTS, methods: ['CASH_ON_DELIVERY'] },
    CARRIER: { facts: REMITTANCE_FACTS, methods: ['CASH_ON_DELIVERY'] },
  },
  DEFERRED_INVOICE_RECEIPT: { BANK_ACCOUNTING: { facts: RECEIPT_FACTS, methods: ['DEFERRED_INVOICE'] } },
  GATEWAY_OUTCOME: {
    PAYMENT_GATEWAY: {
      facts: [
        'COLLECTION_PENDING',
        'COLLECTION_CONFIRMED',
        'COLLECTION_NOT_EFFECTED',
        'CANCEL_CONFIRMED',
        'CANCEL_NOT_EFFECTED',
        'REFUND_PENDING',
        'REFUND_CONFIRMED',
        'REFUND_NOT_EFFECTED',
        'SOURCE_CORRECTION',
      ],
      methods: ['ONLINE_GATEWAY'],
    },
  },
  LOCAL_POS_COLLECTION: { LOCAL_POS_OPERATOR: { facts: HANDOVER_FACTS, methods: ['PAY_ON_PICKUP_OR_ON_SITE'] } },
  REFUND_EXECUTION: {
    // Merchant-side bank/accounting executes bank, deferred and COD refunds; carriers never refund.
    BANK_ACCOUNTING: { facts: REFUND_EFFECT_FACTS, methods: NON_GATEWAY_METHODS },
    // A governed POS/local refund function exists only for pickup/on-site collection.
    LOCAL_POS_OPERATOR: { facts: REFUND_EFFECT_FACTS, methods: ['PAY_ON_PICKUP_OR_ON_SITE'] },
    // A manual external route is an executor, not effect evidence: it reports a request only.
    MANUAL_EXTERNAL_REFUND: { facts: ['REFUND_PENDING'], methods: NON_GATEWAY_METHODS },
    // Gateway refunds execute only through the original provider family/account/environment
    // (#1150, C17 #1155/#1158); the route itself is matched against that binding by #1150.
    PAYMENT_GATEWAY: { facts: REFUND_EFFECT_FACTS, methods: ['ONLINE_GATEWAY'] },
  },
  SETTLEMENT_REMITTANCE: {
    BANK_ACCOUNTING: {
      facts: REMITTANCE_FACTS,
      methods: ['ONLINE_GATEWAY', 'BANK_TRANSFER_ADVANCE', 'DEFERRED_INVOICE', 'PAY_ON_PICKUP_OR_ON_SITE'],
    },
    PAYMENT_GATEWAY: { facts: REMITTANCE_FACTS, methods: ['ONLINE_GATEWAY'] },
  },
});

const authorityRule = (family: PaymentSourceFactFamily, kind: PaymentSourceKind): SourceFactAuthority | undefined =>
  PAYMENT_SOURCE_FACT_AUTHORITY[family][kind];

/** Why a requested authority configuration is invalid; `undefined` when it is a valid combination. */
export const sourceAuthorityConfigurationProblem = (configuration: {
  readonly factFamily: PaymentSourceFactFamily;
  readonly method: PaymentMethod | undefined;
  readonly refundRoute: boolean;
  readonly sourceKind: PaymentSourceKind;
}): string | undefined => {
  const rule = authorityRule(configuration.factFamily, configuration.sourceKind);
  if (rule === undefined) {
    return `A ${configuration.sourceKind} source cannot be authority for ${configuration.factFamily}`;
  }
  if (configuration.method !== undefined && !rule.methods.includes(configuration.method)) {
    return `${configuration.factFamily} from ${configuration.sourceKind} does not apply to ${configuration.method}`;
  }
  if (configuration.refundRoute !== (configuration.factFamily === 'REFUND_EXECUTION')) {
    return 'A refund route is configured exactly for the REFUND_EXECUTION fact family';
  }
  return undefined;
};

/** One configured authority row as qualification reads it. */
export interface PaymentSourceAuthorityView {
  readonly accountRef: string;
  /**
   * Whether the trusted principal of the current invocation is one of `submitterPrincipalIds`: decided
   * by the owner persistence from the Core operation scope, never from the statement.
   */
  readonly boundToSubmitter: boolean;
  readonly environment: string;
  readonly factFamily: PaymentSourceFactFamily;
  readonly method: PaymentMethod | undefined;
  readonly refundRoute: boolean;
  readonly revision: number;
  readonly sourceAuthorityId: string;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
  readonly status: PaymentSourceAuthorityStatus;
  /** The principals bound to submit as this authority at its current revision. */
  readonly submitterPrincipalIds: readonly string[];
}

/** One recorded observation (immutable evidence) as qualification compares it. */
export interface PaymentRecordedObservationView {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly amount: PaymentMonetaryAmount | undefined;
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly evidenceRef: string | undefined;
  readonly factFamily: PaymentSourceFactFamily;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly sourceAuthorityId: string | undefined;
  readonly sourceOccurredAt: DateTime.Utc | undefined;
}

/** The Current Payment as qualification needs it (structurally satisfied by the aggregate records). */
export interface PaymentSourceTargetView {
  readonly operations: readonly {
    readonly binding: PaymentExecutionBinding;
    readonly kind: PaymentOperationKind;
    readonly operationId: string;
    readonly outcome: PaymentOperationOutcome;
    /** The configured executor a REFUND was requested through (#1150); absent for other kinds. */
    readonly refundExecutionRoute?:
      | { readonly sourceAuthorityId: string; readonly sourceKind: PaymentSourceKind }
      | undefined;
  }[];
  readonly payment: {
    readonly amount: PaymentMonetaryAmount;
    readonly executionBinding: PaymentExecutionBinding;
    readonly method: PaymentMethod;
    readonly paymentId: string;
  };
}

/** The decoded statement, independent of the Action it entered through. */
export interface PaymentSourceStatement {
  readonly amount?: PaymentSourceClaimedAmount | undefined;
  readonly correctsObservationId?: string | undefined;
  readonly deliveryOfferRef?: string | undefined;
  readonly economicEffectKey?: string | undefined;
  readonly evidenceRef?: string | undefined;
  readonly factFamily: PaymentSourceFactFamily;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId?: string | undefined;
  readonly paymentId?: string | undefined;
  readonly pickupCapabilityRef?: string | undefined;
  readonly source: PaymentSourceBinding;
  readonly sourceOccurredAt?: DateTime.Utc | undefined;
  readonly sourceOccurrenceId: string;
  readonly sourceRevision: number;
}

export interface PaymentSourceQualificationInput {
  /** Authorities whose exact binding and fact family equal the statement's (any status, any method). */
  readonly authorities: readonly PaymentSourceAuthorityView[];
  /** The accepted observation a SOURCE_CORRECTION names, when it exists in this scope. */
  readonly correctedObservation: PaymentRecordedObservationView | undefined;
  readonly entry: PaymentSourceEntry;
  /** The observation already recorded for the same source occurrence and revision, if any. */
  readonly existingOccurrence: PaymentRecordedObservationView | undefined;
  readonly statement: PaymentSourceStatement;
  /** The correlated Payment, loaded under its row lock; undefined when absent from the trusted scope. */
  readonly target: PaymentSourceTargetView | undefined;
}

export const PAYMENT_SOURCE_HELD_REASONS = [
  /** The statement does not prove the exact selected Delivery Offer / pickup capability. */
  'CAPABILITY_NOT_CORRELATED',
  /** The correction does not name an accepted observation of this Payment. */
  'CORRECTION_TARGET_UNKNOWN',
] as const;
export type PaymentSourceHeldReason = (typeof PAYMENT_SOURCE_HELD_REASONS)[number];

export type PaymentSourceQualificationCase = Data.TaggedEnum<{
  /** The claimed currency differs from the exact Payment currency (refused, nothing recorded). */
  CurrencyMismatch: { readonly claimed: string; readonly required: string };
  /** The exact source occurrence and revision was already recorded with the same content. */
  Duplicate: { readonly original: PaymentRecordedObservationView };
  /** Qualified source, unresolved correlation: recorded as held reconciliation debt. */
  Held: {
    readonly authority: PaymentSourceAuthorityView;
    readonly operationId: Option.Option<string>;
    readonly paymentId: string;
    readonly reason: PaymentSourceHeldReason;
  };
  /** Qualified source without an exact Payment in this scope: held, assigned to no Payment. */
  HeldUnassigned: { readonly authority: PaymentSourceAuthorityView };
  /** Same source occurrence and revision with different content (refused, nothing recorded). */
  OccurrenceConflict: { readonly original: PaymentRecordedObservationView };
  /** Exact authority, scope, binding and correlation: hand to the evidence interpretation. */
  Qualified: {
    readonly authority: PaymentSourceAuthorityView;
    readonly observation: QualifiedPaymentObservation;
    readonly paymentId: string;
  };
  /** UNAUTHORIZED_SOURCE: never mutates the target Payment. */
  Unauthorized: { readonly reason: string };
  /** UNSUPPORTED_FACT: never mutates the target Payment. */
  Unsupported: { readonly reason: string };
}>;
export const PaymentSourceQualification = Data.taggedEnum<PaymentSourceQualificationCase>();

/**
 * Sources that speak for a Payment only through its exact selected capability (#1152): the COD carrier
 * must name the selected Delivery Offer, the local POS operator the selected pickup capability.
 */
export const PAYMENT_SELECTED_CAPABILITY_SOURCES: ReadonlySet<PaymentSourceKind> = new Set([
  'CARRIER',
  'LOCAL_POS_OPERATOR',
] as const);

/**
 * Whether qualification proved that a selected-capability statement names the selected capability of
 * its Payment, recorded with the observation so governed attachment can rely on it later. Only
 * CAPABILITY_NOT_CORRELATED leaves it unproven; every other Payment-correlated outcome passed the exact
 * binding check. `undefined` for other sources and for evidence without a Payment.
 */
export const selectedCapabilityCorrelation = (
  statement: PaymentSourceStatement,
  qualification: PaymentSourceQualificationCase,
): boolean | undefined => {
  if (!PAYMENT_SELECTED_CAPABILITY_SOURCES.has(statement.source.sourceKind)) {
    return undefined;
  }
  if (PaymentSourceQualification.$is('Qualified')(qualification)) {
    return true;
  }
  // Only Held and Qualified record Payment-correlated evidence; HeldUnassigned names no Payment.
  return PaymentSourceQualification.$is('Held')(qualification)
    ? qualification.reason !== 'CAPABILITY_NOT_CORRELATED'
    : undefined;
};

const unauthorized = (reason: string) => PaymentSourceQualification.Unauthorized({ reason });

/**
 * The one refusal for a submitter that is not bound to an ACTIVE authority of the exact source binding
 * and fact family. Unknown, revoked and configured-but-unbound bindings refuse identically, so a refusal
 * never tells an unbound principal which source bindings are configured (#1153).
 */
const NOT_A_BOUND_AUTHORITY = unauthorized(
  'The submitting principal is not bound to an active configured authority for this source binding and fact family',
);

const sameInstant = (left: DateTime.Utc | undefined, right: DateTime.Utc | undefined): boolean =>
  left === undefined || right === undefined ? left === right : DateTime.Equivalence(left, right);

/** Exact duplicate: the stable statement content equals what the original occurrence recorded. */
const sameStatement = (recorded: PaymentRecordedObservationView, statement: PaymentSourceStatement): boolean =>
  recorded.factFamily === statement.factFamily &&
  recorded.factKind === statement.factKind &&
  recorded.correctsObservationId === statement.correctsObservationId &&
  recorded.economicEffectKey === statement.economicEffectKey &&
  recorded.evidenceRef === statement.evidenceRef &&
  sameInstant(recorded.sourceOccurredAt, statement.sourceOccurredAt) &&
  (recorded.paymentId === undefined || recorded.paymentId === statement.paymentId) &&
  (statement.operationId === undefined || recorded.operationId === statement.operationId) &&
  (recorded.amount === undefined ||
    (recorded.amount.amountMinor === statement.amount?.amountMinor &&
      recorded.amount.currency === statement.amount.currency));

/** Unassigned held evidence names the configured authority of its source binding (method-neutral first). */
const unassignedAuthority = (active: readonly PaymentSourceAuthorityView[]): PaymentSourceAuthorityView | undefined =>
  active.find((authority) => authority.method === undefined) ??
  active.toSorted((left, right) => left.sourceAuthorityId.localeCompare(right.sourceAuthorityId))[0];

const MATCHED = Option.none<'MISMATCH' | 'MISSING'>();
const MISMATCHED = Option.some<'MISMATCH' | 'MISSING'>('MISMATCH');
const MISSING = Option.some<'MISMATCH' | 'MISSING'>('MISSING');

/** An exact selected capability reference: absent means unproven, different means foreign. */
const capabilityProblem = (claimed: string | undefined, selected: string) => {
  if (claimed === undefined) {
    return MISSING;
  }
  return claimed === selected ? MATCHED : MISMATCHED;
};

/**
 * The original binding check: the source must be the exact provider account/environment, the exact
 * selected COD carrier naming the selected Delivery Offer, or the exact pickup capability of the
 * Payment. None means it matches.
 */
const bindingProblem = (statement: PaymentSourceStatement, binding: PaymentExecutionBinding) => {
  const { source } = statement;
  return Match.value(source.sourceKind).pipe(
    Match.when('PAYMENT_GATEWAY', () =>
      Match.value(binding).pipe(
        Match.tag('GATEWAY_ACCOUNT', (gateway) =>
          gateway.providerFamily === source.sourceSystem &&
          gateway.providerAccountRef === source.accountRef &&
          gateway.environment === source.environment
            ? MATCHED
            : MISMATCHED,
        ),
        Match.orElse(() => MISMATCHED),
      ),
    ),
    Match.when('CARRIER', () =>
      Match.value(binding).pipe(
        Match.tag('COD_DELIVERY_OFFER', (offer) => codCarrierBindingProblem(statement, offer)),
        Match.orElse(() => MISMATCHED),
      ),
    ),
    Match.when('LOCAL_POS_OPERATOR', () =>
      Match.value(binding).pipe(
        Match.tag('PICKUP_CAPABILITY', (pickup) =>
          capabilityProblem(statement.pickupCapabilityRef, pickup.pickupCapabilityRef),
        ),
        Match.orElse(() => MISMATCHED),
      ),
    ),
    Match.orElse(() => MATCHED),
  );
};

/** The operation kind a fact concerns; settlement evidence concerns the collection lineage. */
const correlatedOperationKind = (factKind: PaymentObservationFactKind): PaymentOperationKind | undefined =>
  factKind === 'SETTLEMENT_OBSERVED' ? 'COLLECT' : paymentFactMeaning(factKind)?.kind;

/**
 * Exact operation correlation. An explicit identity is passed on (interpretation holds a foreign or
 * mismatching one). Without it, only the single live-or-proven COLLECT lineage (#1148 invariant) is
 * exact; refunds and cancellations must name their operation.
 */
const correlateOperation = (statement: PaymentSourceStatement, target: PaymentSourceTargetView): string | undefined => {
  if (statement.operationId !== undefined) {
    return statement.operationId;
  }
  if (correlatedOperationKind(statement.factKind) !== 'COLLECT') {
    return undefined;
  }
  const lineage = target.operations.filter(
    (operation) => operation.kind === 'COLLECT' && operation.outcome !== 'NOT_EFFECTED_CONFIRMED',
  );
  return lineage.length === 1 ? lineage[0]?.operationId : undefined;
};

/**
 * Facts that claim money was collected or returned. Such a statement must provide the exact amount and
 * currency (#1152 "Qualified source statement contract", "Manual/local collection evidence"); without
 * them it proves no effect and could otherwise confirm a full COLLECT for an unknown or partial sum.
 */
const claimsMonetaryEffect = (factKind: PaymentObservationFactKind): boolean => {
  const meaning = paymentFactMeaning(factKind);
  return meaning?.outcome === 'EFFECT_CONFIRMED' && meaning.kind !== 'CANCEL_OR_VOID';
};

const exactAmount = (claimed: PaymentSourceClaimedAmount | undefined): PaymentMonetaryAmount | undefined =>
  claimed === undefined ? undefined : { amountMinor: claimed.amountMinor, currency: PAYMENT_LAUNCH_CURRENCY };

/**
 * A REFUND keeps the executor it was requested through: another account or system of the same executor
 * kind never evidences it, and a revoked original route is explicit, never replaced (#1150/#1152).
 */
const bypassesOriginalRefundRoute = (
  statement: PaymentSourceStatement,
  active: readonly PaymentSourceAuthorityView[],
  operation: PaymentSourceTargetView['operations'][number] | undefined,
): boolean => {
  const route = statement.factFamily === 'REFUND_EXECUTION' ? operation?.refundExecutionRoute : undefined;
  return (
    route !== undefined &&
    route.sourceKind === statement.source.sourceKind &&
    !active.some((candidate) => candidate.sourceAuthorityId === route.sourceAuthorityId)
  );
};

const qualifyAgainstPayment = (
  input: PaymentSourceQualificationInput,
  active: readonly PaymentSourceAuthorityView[],
  target: PaymentSourceTargetView,
): PaymentSourceQualificationCase => {
  const { statement } = input;
  const { payment } = target;
  const authority =
    active.find((candidate) => candidate.method === payment.method) ??
    active.find((candidate) => candidate.method === undefined);
  if (authority === undefined) {
    return unauthorized(`The source is not a configured ${statement.factFamily} authority for ${payment.method}`);
  }
  const rule = authorityRule(statement.factFamily, statement.source.sourceKind);
  if (rule === undefined || !rule.methods.includes(payment.method)) {
    return unauthorized(`${statement.factFamily} is not evidence for a ${payment.method} Payment`);
  }
  if (statement.factFamily === 'REFUND_EXECUTION' && !authority.refundRoute) {
    return unauthorized('The source is not a configured refund execution route');
  }
  const binding = bindingProblem(statement, payment.executionBinding);
  if (Option.contains(binding, 'MISMATCH')) {
    return unauthorized('The statement does not match the original execution binding or selected capability');
  }
  const operationId = correlateOperation(statement, target);
  const operation = target.operations.find((candidate) => candidate.operationId === operationId);
  if (operation !== undefined && Option.contains(bindingProblem(statement, operation.binding), 'MISMATCH')) {
    return unauthorized('The statement does not match the original binding of the correlated operation');
  }
  if (bypassesOriginalRefundRoute(statement, active, operation)) {
    return unauthorized('The statement does not come from the refund execution route the REFUND was requested through');
  }
  if (Option.contains(binding, 'MISSING')) {
    return PaymentSourceQualification.Held({
      authority,
      operationId: Option.fromNullishOr(operation?.operationId),
      paymentId: payment.paymentId,
      reason: 'CAPABILITY_NOT_CORRELATED',
    });
  }
  if (statement.factKind === 'SOURCE_CORRECTION') {
    const corrected = input.correctedObservation;
    if (corrected === undefined || corrected.paymentId !== payment.paymentId) {
      return PaymentSourceQualification.Held({
        authority,
        operationId: Option.fromNullishOr(operation?.operationId),
        paymentId: payment.paymentId,
        reason: 'CORRECTION_TARGET_UNKNOWN',
      });
    }
    if (corrected.sourceAuthorityId !== authority.sourceAuthorityId) {
      return unauthorized('Only the authority that issued a statement can correct it');
    }
  }
  return PaymentSourceQualification.Qualified({
    authority,
    observation: {
      amount: exactAmount(statement.amount),
      correctsObservationId: statement.correctsObservationId,
      economicEffectKey: statement.economicEffectKey,
      factKind: statement.factKind,
      operationId,
      source: statement.source,
      sourceAuthorityId: authority.sourceAuthorityId,
    },
    paymentId: payment.paymentId,
  });
};

/** Qualifies one source statement. Only `Held` and `Qualified` may record evidence. */
export const qualifyPaymentSourceStatement = (
  input: PaymentSourceQualificationInput,
): PaymentSourceQualificationCase => {
  const { statement } = input;
  if (!ENTRY_SOURCE_KINDS[input.entry].includes(statement.source.sourceKind)) {
    return unauthorized(
      input.entry === 'INTEGRATION'
        ? 'Operator, POS and manual statements require the local evidence Action and its permission'
        : 'Local evidence is accepted only from a configured local POS/operator or manual refund source',
    );
  }
  const active = input.authorities.filter(
    (authority) =>
      authority.status === 'ACTIVE' &&
      authority.factFamily === statement.factFamily &&
      authority.sourceKind === statement.source.sourceKind &&
      authority.sourceSystem === statement.source.sourceSystem &&
      authority.accountRef === statement.source.accountRef &&
      authority.environment === statement.source.environment,
  );
  const bound = active.filter((authority) => authority.boundToSubmitter);
  if (bound.length === 0) {
    return NOT_A_BOUND_AUTHORITY;
  }
  const rule = authorityRule(statement.factFamily, statement.source.sourceKind);
  if (rule === undefined || !rule.facts.includes(statement.factKind)) {
    return PaymentSourceQualification.Unsupported({
      reason: `${statement.factKind} is not a fact ${statement.factFamily} from ${statement.source.sourceKind} establishes`,
    });
  }
  if (statement.amount === undefined && claimsMonetaryEffect(statement.factKind)) {
    return PaymentSourceQualification.Unsupported({
      reason: `${statement.factKind} establishes money movement only with its exact amount and currency`,
    });
  }
  const requiredCurrency = input.target?.payment.amount.currency ?? PAYMENT_LAUNCH_CURRENCY;
  if (statement.amount !== undefined && statement.amount.currency !== requiredCurrency) {
    return PaymentSourceQualification.CurrencyMismatch({
      claimed: statement.amount.currency,
      required: requiredCurrency,
    });
  }
  const { existingOccurrence } = input;
  if (existingOccurrence !== undefined) {
    return sameStatement(existingOccurrence, statement)
      ? PaymentSourceQualification.Duplicate({ original: existingOccurrence })
      : PaymentSourceQualification.OccurrenceConflict({ original: existingOccurrence });
  }
  if (input.target === undefined) {
    const authority = unassignedAuthority(bound);
    return authority === undefined ? NOT_A_BOUND_AUTHORITY : PaymentSourceQualification.HeldUnassigned({ authority });
  }
  return qualifyAgainstPayment(input, bound, input.target);
};
