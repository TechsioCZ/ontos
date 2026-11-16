import { Data, DateTime, Match, Option } from 'effect';

import {
  isBankAccountingReceiptBinding,
  isPickupCapabilityBinding,
  sameBankReceiptAuthority,
} from '../../shared/domain/payment-execution-binding.ts';
import type {
  PaymentBankReceiptAuthority,
  PaymentExecutionBinding,
} from '../../shared/domain/payment-execution-binding.ts';
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
import type { PaymentRefundExecutionRoute } from '../../shared/domain/refund-contract.ts';
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
 *   evidence Action. Manual refund outcomes and corrections also require governed executor evidence
 *   before recording or interpretation.
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
  'REFUND_INDETERMINATE',
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
    // The source authority identifies the executor. Acceptance separately verifies its outcome evidence.
    MANUAL_EXTERNAL_REFUND: { facts: REFUND_EFFECT_FACTS, methods: ['PAY_ON_PICKUP_OR_ON_SITE'] },
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

export const isBankReceiptFactFamily = (family: PaymentSourceFactFamily): boolean =>
  family === 'BANK_ACCOUNTING_RECEIPT' || family === 'DEFERRED_INVOICE_RECEIPT';

/** Why a requested authority configuration is invalid; `undefined` when it is a valid combination. */
export const sourceAuthorityConfigurationProblem = (configuration: {
  readonly factFamily: PaymentSourceFactFamily;
  readonly method: PaymentMethod | undefined;
  readonly pickupCapabilityRef?: string | undefined;
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
  if (configuration.sourceKind === 'MANUAL_EXTERNAL_REFUND' && configuration.method !== 'PAY_ON_PICKUP_OR_ON_SITE') {
    return 'A manual external refund route must explicitly cover pickup or on-site collection';
  }
  if ((configuration.sourceKind === 'LOCAL_POS_OPERATOR') !== (configuration.pickupCapabilityRef !== undefined)) {
    return 'An exact pickup capability is required only for a POS/operator authority';
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
  readonly pickupCapabilityRef?: string | undefined;
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
  /** A governed attachment established an operation without rewriting the original occurrence. */
  readonly attachedOperationId?: string | undefined;
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
  /** SHA-256 of the statement exactly as its source claimed it (`paymentSourceStatementMaterial`). */
  readonly statementHash: string;
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
      | Pick<
          PaymentRefundExecutionRoute,
          'accountRef' | 'environment' | 'sourceAuthorityId' | 'sourceKind' | 'sourceSystem'
        >
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
  /** SHA-256 of `paymentSourceStatementMaterial(statement)`: what a redelivery must equal to replay. */
  readonly statementHash: string;
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

/**
 * The statement exactly as its source claimed it, as canonical JSON material. Its hash is stored with the
 * observation, so a redelivery is an exact duplicate only when it claims the same content, whatever
 * Payment, operation or capability qualification later resolved, inferred or dropped (#1151/#1152).
 */
export const paymentSourceStatementMaterial = (statement: PaymentSourceStatement) => ({
  amount:
    statement.amount === undefined
      ? null
      : { amountMinor: statement.amount.amountMinor, currency: statement.amount.currency },
  correctsObservationId: statement.correctsObservationId ?? null,
  deliveryOfferRef: statement.deliveryOfferRef ?? null,
  economicEffectKey: statement.economicEffectKey ?? null,
  evidenceRef: statement.evidenceRef ?? null,
  factFamily: statement.factFamily,
  factKind: statement.factKind,
  operationId: statement.operationId ?? null,
  paymentId: statement.paymentId ?? null,
  pickupCapabilityRef: statement.pickupCapabilityRef ?? null,
  source: {
    accountRef: statement.source.accountRef,
    environment: statement.source.environment,
    sourceKind: statement.source.sourceKind,
    sourceSystem: statement.source.sourceSystem,
  },
  sourceOccurredAt: statement.sourceOccurredAt === undefined ? null : DateTime.formatIso(statement.sourceOccurredAt),
  sourceOccurrenceId: statement.sourceOccurrenceId,
  sourceRevision: statement.sourceRevision,
});

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

const collectionLineage = (target: PaymentSourceTargetView) =>
  target.operations.filter((operation) => operation.kind === 'COLLECT');

/**
 * Without an explicit operation identity, a statement can correlate only when there has been one
 * collection attempt. An earlier not-effected attempt may still receive late contradictory evidence.
 */
const correlateOperation = (statement: PaymentSourceStatement, target: PaymentSourceTargetView): string | undefined => {
  if (statement.operationId !== undefined) {
    return statement.operationId;
  }
  if (correlatedOperationKind(statement.factKind) !== 'COLLECT') {
    return undefined;
  }
  const lineage = collectionLineage(target);
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

type SourceTargetOperation = PaymentSourceTargetView['operations'][number];

/** A canonical REFUND can only be evidenced by the recorded executor of that operation. */
const matchesOriginalRefundAuthority = (
  operation: SourceTargetOperation,
  authority: PaymentSourceAuthorityView,
  method: PaymentMethod,
): boolean => {
  const route = operation.refundExecutionRoute;
  return (
    route !== undefined &&
    authority.factFamily === 'REFUND_EXECUTION' &&
    authority.refundRoute &&
    (authority.method === undefined || authority.method === method) &&
    authority.sourceAuthorityId === route.sourceAuthorityId &&
    authority.sourceKind === route.sourceKind &&
    authority.sourceSystem === route.sourceSystem &&
    authority.accountRef === route.accountRef &&
    authority.environment === route.environment
  );
};

const correctionOperationOf = (
  input: PaymentSourceQualificationInput,
  target: PaymentSourceTargetView,
): SourceTargetOperation | undefined => {
  const corrected = input.correctedObservation;
  if (input.statement.factKind !== 'SOURCE_CORRECTION' || corrected?.paymentId !== target.payment.paymentId) {
    return undefined;
  }
  const operationId = corrected.operationId ?? corrected.attachedOperationId;
  return target.operations.find((operation) => operation.operationId === operationId);
};

/** The bound ACTIVE authority that issued the observation a correction names on this Payment, if still configured. */
const issuingAuthorityOf = (
  input: PaymentSourceQualificationInput,
  paymentId: string,
  active: readonly PaymentSourceAuthorityView[],
): PaymentSourceAuthorityView | undefined => {
  const corrected = input.correctedObservation;
  if (corrected === undefined || corrected.paymentId !== paymentId || corrected.sourceAuthorityId === undefined) {
    return undefined;
  }
  const issuerId = corrected.sourceAuthorityId;
  return active.find((candidate) => candidate.sourceAuthorityId === issuerId);
};

const matchingMethodAuthority = (active: readonly PaymentSourceAuthorityView[], method: PaymentMethod) =>
  active.find((candidate) => candidate.method === method) ?? active.find((candidate) => candidate.method === undefined);

const bankReceiptAuthorityOf = (
  operation: PaymentSourceTargetView['operations'][number] | undefined,
): PaymentBankReceiptAuthority | undefined => {
  const binding = operation?.kind === 'COLLECT' ? operation.binding : undefined;
  return isBankAccountingReceiptBinding(binding) ? binding.receiptAuthority : undefined;
};

/** The original source can be proved even when the statement cannot identify which attempt it concerns. */
const sharedBankReceiptAuthority = (target: PaymentSourceTargetView): PaymentBankReceiptAuthority | undefined => {
  const [first, ...others] = collectionLineage(target);
  const original = bankReceiptAuthorityOf(first);
  if (original === undefined) {
    return undefined;
  }
  const sameOriginal = others.every((operation) => {
    const candidate = bankReceiptAuthorityOf(operation);
    return candidate !== undefined && sameBankReceiptAuthority(original, candidate);
  });
  return sameOriginal ? original : undefined;
};

const matchingBankReceiptAuthority = (
  input: PaymentSourceQualificationInput,
  active: readonly PaymentSourceAuthorityView[],
  target: PaymentSourceTargetView,
  operation: PaymentSourceTargetView['operations'][number] | undefined,
  issuer: PaymentSourceAuthorityView | undefined,
): PaymentSourceAuthorityView | undefined => {
  const { method, paymentId } = target.payment;
  const corrected = input.correctedObservation;
  if (
    input.statement.factKind === 'SOURCE_CORRECTION' &&
    (corrected === undefined || corrected.paymentId !== paymentId)
  ) {
    // The existing correction path holds an unresolved target without applying any effect.
    return matchingMethodAuthority(active, method);
  }
  const receiptOperation =
    operation ??
    (issuer === undefined
      ? undefined
      : target.operations.find((candidate) => candidate.operationId === corrected?.operationId));
  const original =
    receiptOperation === undefined && input.statement.factKind === 'COLLECTION_CONFIRMED'
      ? sharedBankReceiptAuthority(target)
      : bankReceiptAuthorityOf(receiptOperation);
  if (original === undefined) {
    // A recorded issuer can correct an accepted historical receipt, but cannot add a new one.
    return corrected?.acceptanceOutcome === 'ACCEPTED_OBSERVATION' ? issuer : undefined;
  }
  return active.find(
    (candidate) =>
      (candidate.method === undefined || candidate.method === method) && sameBankReceiptAuthority(original, candidate),
  );
};

const correctionQualificationProblem = (
  corrected: PaymentRecordedObservationView | undefined,
  authority: PaymentSourceAuthorityView,
  paymentId: string,
  operationId: string | undefined,
): PaymentSourceQualificationCase | undefined => {
  if (corrected === undefined || corrected.paymentId !== paymentId) {
    return PaymentSourceQualification.Held({
      authority,
      operationId: Option.fromNullishOr(operationId),
      paymentId,
      reason: 'CORRECTION_TARGET_UNKNOWN',
    });
  }
  if (corrected.sourceAuthorityId !== authority.sourceAuthorityId) {
    return unauthorized('Only the authority that issued a statement can correct it');
  }
  return undefined;
};

const authorityCoversPickupCapability = (
  authority: PaymentSourceAuthorityView,
  pickupCapabilityRef: string | undefined,
): boolean => {
  if (authority.sourceKind === 'MANUAL_EXTERNAL_REFUND') {
    return authority.method === 'PAY_ON_PICKUP_OR_ON_SITE';
  }
  return (
    authority.sourceKind !== 'LOCAL_POS_OPERATOR' ||
    (pickupCapabilityRef !== undefined && authority.pickupCapabilityRef === pickupCapabilityRef)
  );
};

const matchingOperationAuthority = (
  input: PaymentSourceQualificationInput,
  active: readonly PaymentSourceAuthorityView[],
  target: PaymentSourceTargetView,
  operation: SourceTargetOperation | undefined,
): PaymentSourceAuthorityView | undefined => {
  const original = correctionOperationOf(input, target) ?? operation;
  if (original?.kind === 'REFUND') {
    return active.find((candidate) => matchesOriginalRefundAuthority(original, candidate, target.payment.method));
  }
  // Corrections stay with the original issuer, even when a more specific authority was added later.
  const issuer =
    input.statement.factKind === 'SOURCE_CORRECTION'
      ? issuingAuthorityOf(input, target.payment.paymentId, active)
      : undefined;
  return isBankReceiptFactFamily(input.statement.factFamily)
    ? matchingBankReceiptAuthority(input, active, target, operation, issuer)
    : (issuer ?? matchingMethodAuthority(active, target.payment.method));
};

const qualifyAgainstPayment = (
  input: PaymentSourceQualificationInput,
  bound: readonly PaymentSourceAuthorityView[],
  target: PaymentSourceTargetView,
): PaymentSourceQualificationCase => {
  const { statement } = input;
  const { payment } = target;
  const bindingRef = isPickupCapabilityBinding(payment.executionBinding)
    ? payment.executionBinding.pickupCapabilityRef
    : undefined;
  const active = bound.filter((authority) => authorityCoversPickupCapability(authority, bindingRef));
  const operationId = correlateOperation(statement, target);
  const operation = target.operations.find((candidate) => candidate.operationId === operationId);
  const authority = matchingOperationAuthority(input, active, target, operation);
  if (authority === undefined) {
    return unauthorized(
      isBankReceiptFactFamily(statement.factFamily)
        ? 'The statement does not prove the original bank receipt authority of the collection'
        : `The source is not a configured ${statement.factFamily} authority for ${payment.method}`,
    );
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
  if (operation !== undefined && Option.contains(bindingProblem(statement, operation.binding), 'MISMATCH')) {
    return unauthorized('The statement does not match the original binding of the correlated operation');
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
    const problem = correctionQualificationProblem(
      input.correctedObservation,
      authority,
      payment.paymentId,
      operation?.operationId,
    );
    if (problem !== undefined) {
      return problem;
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

const canReplayOccurrence = (
  original: PaymentRecordedObservationView,
  bound: readonly PaymentSourceAuthorityView[],
  target: PaymentSourceTargetView | undefined,
): boolean => {
  const issuer = bound.find(
    (authority) =>
      authority.factFamily === original.factFamily && authority.sourceAuthorityId === original.sourceAuthorityId,
  );
  if (issuer === undefined) {
    return false;
  }
  const operationId = original.operationId ?? original.attachedOperationId;
  if (operationId === undefined) {
    return true;
  }
  if (target === undefined) {
    return false;
  }
  const operation = target.operations.find((candidate) => candidate.operationId === operationId);
  return (
    operation !== undefined &&
    (operation.kind !== 'REFUND' || matchesOriginalRefundAuthority(operation, issuer, target.payment.method))
  );
};

const exactPaymentTarget = (
  target: PaymentSourceTargetView | undefined,
  operationId: string | undefined,
): PaymentSourceTargetView | undefined => {
  if (target === undefined || operationId === undefined) {
    return target;
  }
  return target.operations.some((operation) => operation.operationId === operationId) ? target : undefined;
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
  const { existingOccurrence } = input;
  // The occurrence belongs to its recorded authority, even if another method shares the same source tuple.
  if (existingOccurrence !== undefined && !canReplayOccurrence(existingOccurrence, bound, input.target)) {
    return NOT_A_BOUND_AUTHORITY;
  }
  const rule = authorityRule(statement.factFamily, statement.source.sourceKind);
  if (rule === undefined || !rule.facts.includes(statement.factKind)) {
    return PaymentSourceQualification.Unsupported({
      reason: `${statement.factKind} is not a fact ${statement.factFamily} from ${statement.source.sourceKind} establishes`,
    });
  }
  if (statement.factKind === 'REFUND_INDETERMINATE' && statement.amount === undefined) {
    return PaymentSourceQualification.Unsupported({
      reason: 'An unknown refund outcome must identify the exact refund amount and currency',
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
  if (existingOccurrence !== undefined) {
    // An exact redelivery claims the same content; anything else is a changed statement (#1151).
    return existingOccurrence.statementHash === input.statementHash
      ? PaymentSourceQualification.Duplicate({ original: existingOccurrence })
      : PaymentSourceQualification.OccurrenceConflict({ original: existingOccurrence });
  }
  const target = exactPaymentTarget(input.target, statement.operationId);
  if (target === undefined) {
    // An explicit operation absent from the named Payment cannot attach debt to either Payment.
    const authority = unassignedAuthority(
      bound.filter((candidate) => authorityCoversPickupCapability(candidate, statement.pickupCapabilityRef)),
    );
    return authority === undefined ? NOT_A_BOUND_AUTHORITY : PaymentSourceQualification.HeldUnassigned({ authority });
  }
  return qualifyAgainstPayment(input, bound, target);
};
