import { Effect, Match, Option, Schema } from 'effect';
import type { DateTime } from 'effect';

import type { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';
import type { PaymentOperationKind } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import { GatewayEnvironmentSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderEvidenceFactKind, ProviderFinding } from '../../../shared/domain/psp-vocabulary.ts';
import { deriveProviderCorrelation, GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import type { GatewayOrderReference } from '../psp/psp-correlation.ts';
import {
  GatewayProviderOutcomeUnknown,
  GatewayProviderResponseInvalid,
  GatewayProviderUnavailable,
} from '../psp/psp-errors.ts';
import type {
  GatewayProviderOutcomeUnknownError,
  GatewayProviderResponseInvalidError,
  GatewayProviderUnavailableError,
  GatewayProviderUnsupportedError,
} from '../psp/psp-errors.ts';
import { compareObservedAmount, ProviderReportedAmountSchema } from '../psp/psp-money.ts';
import type { ProviderAmountDiscrepancy, ProviderReportedAmount } from '../psp/psp-money.ts';
import type {
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupTarget,
  ProviderObjectId,
  ProviderObjectRef,
} from '../psp/psp-request.ts';
import type {
  ProviderDispatchResponse,
  ProviderEvidence,
  ProviderEvidenceFactFamily,
  ProviderFindingResult,
} from '../psp/psp-result.ts';
import { COMGATE_UNSUPPORTED_REASONS, comgateUnsupported } from './comgate-capabilities.ts';
import { fromComgatePrice, parseComgateStatementAmount } from './comgate-money.ts';
import { parseComgatePragueWallClock, pragueWallClockToUtc } from './comgate-statement.ts';
import {
  COMGATE_CANCEL_NOT_CHANGEABLE_CODE,
  COMGATE_REFUND_REFUSED_CODES,
  COMGATE_SUCCESS_CODE,
  ComgateCreatePaymentResponseFromJsonSchema,
  ComgatePaymentStatusSchema,
  ComgateResultResponseFromJsonSchema,
  ComgateStatementRowKeySchema,
  ComgateStatementRowSchema,
  ComgateTransIdSchema,
} from './comgate-wire.ts';
import type {
  ComgatePaymentStatus,
  ComgateStatementRawRow,
  ComgateStatusAnswer,
  ComgateStatusFound,
  ComgateTransferId,
} from './comgate-wire.ts';

/**
 * Comgate evidence mapping (#1156, #1157, #1158), plan §4 Comgate and §2.5. Pure functions over
 * decoded provider answers; the adapter (COMGATE-CLIENT) performs the HTTP calls.
 *
 * Rules:
 * - Only `code === 0` is success (donor gap C-5). Any other code, documented or not, is never success.
 * - A lookup miss, `not found` or any non-zero status code is INDETERMINATE, never NOT_EFFECTED (#1158).
 * - Status `price` is parsed exactly; amount or currency mismatch is VERIFICATION_CONFLICT with the
 *   discrepancy attached and the authentic provider amount kept (any currency).
 * - `test`, `merchant` (when present), `transId` and `refId` must match the binding and the dispatch,
 *   else VERIFICATION_CONFLICT; nothing is submitted for another merchant or environment.
 * - Refund `code 0` is REFUND_PENDING only (plan N10): Comgate documents no refund id, state, lookup
 *   or notification. The only machine proof of a refund is its row in the production settlement
 *   statement (plan D-P2, `mapComgateStatementRefund`); nothing ever proves a refund NOT_EFFECTED after
 *   `code 0`.
 * - Cancel `code 0` and `1400` (and every other cancel answer) are resolved by a status lookup.
 *
 * Source occurrence (§2.5): `comgate:<origin>:<transId|none>:<operationId>:<factKind>:<amountMinor>`
 * where origin is `response` (dispatch response) or `lookup` (status lookup, from notification or
 * recovery alike, so the same provider fact deduplicates); a statement row is
 * `comgate:statement:<transferId>:<operationId>:<factKind>:<amountMinor>`. Economic effect key:
 * collection = transId; refund = `comgate-refund:<transId>:<operationId>`.
 */

const FAMILY = 'COMGATE';

type OperationId = typeof PaymentOperationIdSchema.Type;

export const ComgateEvidenceOriginSchema = Schema.Literals(['lookup', 'response', 'statement']);
export type ComgateEvidenceOrigin = typeof ComgateEvidenceOriginSchema.Type;

/** What a Comgate answer must match: the binding's merchant and environment (`test` flag). */
export interface ComgateBindingIdentity {
  readonly merchantId: string;
  readonly test: boolean;
}

const unavailable = (reason: string): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family: FAMILY, reason });

const responseInvalid = (reason: string): GatewayProviderResponseInvalidError =>
  new GatewayProviderResponseInvalid({ code: 'gateway_provider_response_invalid', family: FAMILY, reason });

const outcomeUnknown = (operationId: OperationId, reason: string): GatewayProviderOutcomeUnknownError =>
  new GatewayProviderOutcomeUnknown({ code: 'gateway_provider_outcome_unknown', family: FAMILY, operationId, reason });

/**
 * The Comgate identity of an execution target. A target whose merchant identity is not COMGATE or
 * whose binding environment is not SANDBOX/LIVE is unusable: Unavailable, nothing is sent or trusted.
 */
export const comgateBindingOf = (
  target: GatewayExecutionTarget,
): Effect.Effect<ComgateBindingIdentity, GatewayProviderUnavailableError> =>
  Match.value(target.merchantIdentity).pipe(
    Match.tag('COMGATE', ({ merchantId }) =>
      Option.match(Schema.decodeUnknownOption(GatewayEnvironmentSchema)(target.binding.environment), {
        onNone: () => Effect.fail(unavailable('comgate_binding_environment_invalid')),
        onSome: (environment) => Effect.succeed({ merchantId, test: environment === 'SANDBOX' }),
      }),
    ),
    Match.orElse(() => Effect.fail(unavailable('comgate_binding_family_mismatch'))),
  );

/** The transId of a provider target; a ref of another family is never acted on. */
export const comgateTransIdOfRef = (
  ref: ProviderObjectRef,
  capability: 'CANCEL_OR_VOID' | 'REFUND' | 'RETRIEVE',
): Effect.Effect<ProviderObjectId, GatewayProviderUnsupportedError> =>
  Match.value(ref).pipe(
    Match.tag('COMGATE_TRANSACTION', ({ transId }) => Effect.succeed(transId)),
    Match.orElse(() => Effect.fail(comgateUnsupported(capability, COMGATE_UNSUPPORTED_REASONS.foreignProviderRef))),
  );

/** The transId a Comgate lookup reads. ORDER_REFERENCE has no Comgate endpoint (no lookup by refId). */
export const comgateTransIdOfLookup = (
  target: GatewayLookupTarget,
): Effect.Effect<ProviderObjectId, GatewayProviderUnsupportedError> =>
  Match.value(target).pipe(
    Match.tag('ORDER_REFERENCE', () =>
      Effect.fail(comgateUnsupported('RETRIEVE', COMGATE_UNSUPPORTED_REASONS.orderReferenceLookup)),
    ),
    Match.tag('PROVIDER_OBJECT', ({ ref }) => comgateTransIdOfRef(ref, 'RETRIEVE')),
    Match.exhaustive,
  );

const transactionRef = (transId: ProviderObjectId): ProviderObjectRef => ({ _tag: 'COMGATE_TRANSACTION', transId });

export const comgateRefundEffectKey = (transId: ProviderObjectId, operationId: OperationId): string =>
  `comgate-refund:${transId}:${operationId}`;

interface EvidenceInput {
  readonly amountMinor: number;
  readonly discrepancy: Option.Option<ProviderAmountDiscrepancy>;
  readonly economicEffectKey: Option.Option<string>;
  readonly factKind: ProviderEvidenceFactKind;
  readonly observedAmount: Option.Option<ProviderReportedAmount>;
  readonly observedAt: ProviderEvidence['observedAt'];
  /** The provider object the occurrence id names when it is not the transaction (a statement's transfer id). */
  readonly occurrenceObjectId?: string;
  readonly operationId: OperationId;
  readonly origin: ComgateEvidenceOrigin;
  readonly providerOccurredAt?: Option.Option<DateTime.Utc>;
  readonly transId: Option.Option<ProviderObjectId>;
}

const factFamilyOf = (factKind: ProviderEvidenceFactKind): ProviderEvidenceFactFamily =>
  factKind.startsWith('REFUND_') ? 'REFUND_EXECUTION' : 'GATEWAY_OUTCOME';

const makeEvidence = (input: EvidenceInput): ProviderEvidence => ({
  discrepancy: input.discrepancy,
  economicEffectKey: input.economicEffectKey,
  factFamily: factFamilyOf(input.factKind),
  factKind: input.factKind,
  observedAmount: input.observedAmount,
  observedAt: input.observedAt,
  providerOccurredAt: input.providerOccurredAt ?? Option.none(),
  providerRefs: Option.match(input.transId, { onNone: () => [], onSome: (transId) => [transactionRef(transId)] }),
  reason: Option.none(),
  sourceOccurrenceId: [
    FAMILY.toLowerCase(),
    input.origin,
    input.occurrenceObjectId ?? Option.getOrElse(input.transId, () => 'none'),
    input.operationId,
    input.factKind,
    `${input.amountMinor}`,
  ].join(':'),
  sourceRevision: 0,
});

interface FindingInput {
  readonly customerAction?: Option.Option<{ readonly redirectUrl: string }>;
  readonly evidence: Option.Option<ProviderEvidence>;
  readonly finding: ProviderFinding;
  readonly operationId: OperationId;
  readonly operationKind: PaymentOperationKind;
  readonly orderReference: Option.Option<GatewayOrderReference>;
  readonly transId: Option.Option<ProviderObjectId>;
}

const makeFinding = (input: FindingInput): ProviderFindingResult => ({
  customerAction: input.customerAction ?? Option.none(),
  evidence: input.evidence,
  finding: input.finding,
  orderReference: input.orderReference,
  providerRefs: Option.match(input.transId, { onNone: () => [], onSome: (transId) => [transactionRef(transId)] }),
  target: { operationId: input.operationId, operationKind: input.operationKind },
});

/* ------------------------------------------------------------------------------------------------ */
/* Create (POST /v2.0/payment.json)                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export interface ComgateCreateResponseInput {
  /** Raw response body of a returned (non-5xx) create call. */
  readonly bodyText: string;
  readonly expected: { readonly amount: PaymentMonetaryAmount; readonly operationId: OperationId };
  readonly observedAt: ProviderEvidence['observedAt'];
}

/**
 * `code 0` with `transId` and an https `redirect` is ACKNOWLEDGED / CUSTOMER_ACTION_REQUIRED (no
 * evidence: COLLECTION_PENDING is not submitted). Any other code is REJECTED_BEFORE_EFFECT with
 * COLLECTION_NOT_EFFECTED evidence (plan §4). A body that does not decode, or a `code 0` without a
 * usable transId/redirect, may hide a created payment: OutcomeUnknown (#1158), never success.
 */
export const mapComgateCreateResponse = (
  input: ComgateCreateResponseInput,
): Effect.Effect<ProviderDispatchResponse, GatewayProviderOutcomeUnknownError> => {
  const { expected } = input;
  const decoded = Schema.decodeUnknownOption(ComgateCreatePaymentResponseFromJsonSchema)(input.bodyText);
  if (Option.isNone(decoded)) {
    return Effect.fail(outcomeUnknown(expected.operationId, 'comgate_create_response_unreadable'));
  }
  const response = decoded.value;
  if (response.code !== COMGATE_SUCCESS_CODE) {
    return Effect.succeed({
      _tag: 'REJECTED_BEFORE_EFFECT',
      finding: makeFinding({
        evidence: Option.some(
          makeEvidence({
            amountMinor: expected.amount.amountMinor,
            discrepancy: Option.none(),
            economicEffectKey: Option.none(),
            factKind: 'COLLECTION_NOT_EFFECTED',
            observedAmount: Option.none(),
            observedAt: input.observedAt,
            operationId: expected.operationId,
            origin: 'response',
            transId: Option.none(),
          }),
        ),
        finding: 'NOT_EFFECTED',
        operationId: expected.operationId,
        operationKind: 'COLLECT',
        orderReference: Option.none(),
        transId: Option.none(),
      }),
      targetFinding: Option.none(),
    });
  }
  const transId = Option.flatMap(Option.fromUndefinedOr(response.transId), (value) =>
    Schema.decodeUnknownOption(ComgateTransIdSchema)(value),
  );
  const redirectUrl = Option.flatMap(Option.fromUndefinedOr(response.redirect), (value) =>
    Schema.decodeUnknownOption(GatewayHttpsUrlSchema)(value),
  );
  if (Option.isNone(transId) || Option.isNone(redirectUrl)) {
    return Effect.fail(outcomeUnknown(expected.operationId, 'comgate_create_success_incomplete'));
  }
  return Effect.succeed({
    _tag: 'ACKNOWLEDGED',
    finding: makeFinding({
      customerAction: Option.some({ redirectUrl: redirectUrl.value }),
      evidence: Option.none(),
      finding: 'CUSTOMER_ACTION_REQUIRED',
      operationId: expected.operationId,
      operationKind: 'COLLECT',
      orderReference: Option.none(),
      transId,
    }),
    targetFinding: Option.none(),
  });
};

/* ------------------------------------------------------------------------------------------------ */
/* Cancel (DELETE /v2.0/payment/transId/{id}.json)                                                   */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Classified cancel answer. Every variant is resolved by a status lookup (`mapComgateStatus` with the
 * CANCEL_OR_VOID expectation): ACCEPTED needs a confirming lookup, NOT_CHANGEABLE (1400) means the
 * payment is not found, not PENDING or not ours, and PROVIDER_ERROR/UNREADABLE prove nothing.
 * A cancel answer alone never yields CANCEL_CONFIRMED or CANCEL_NOT_EFFECTED.
 */
export const ComgateCancelAnswerSchema = Schema.Union([
  Schema.TaggedStruct('ACCEPTED', {}),
  Schema.TaggedStruct('NOT_CHANGEABLE', {}),
  Schema.TaggedStruct('PROVIDER_ERROR', { code: Schema.Finite }),
  Schema.TaggedStruct('UNREADABLE', {}),
]);
export type ComgateCancelAnswer = typeof ComgateCancelAnswerSchema.Type;

export const classifyComgateCancelResponse = (bodyText: string): ComgateCancelAnswer =>
  Option.match(Schema.decodeUnknownOption(ComgateResultResponseFromJsonSchema)(bodyText), {
    onNone: (): ComgateCancelAnswer => ({ _tag: 'UNREADABLE' }),
    onSome: ({ code }): ComgateCancelAnswer => {
      if (code === COMGATE_SUCCESS_CODE) {
        return { _tag: 'ACCEPTED' };
      }
      if (code === COMGATE_CANCEL_NOT_CHANGEABLE_CODE) {
        return { _tag: 'NOT_CHANGEABLE' };
      }
      return { _tag: 'PROVIDER_ERROR', code };
    },
  });

/* ------------------------------------------------------------------------------------------------ */
/* Refund (POST /v2.0/refund.json)                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface ComgateRefundResponseInput {
  readonly bodyText: string;
  readonly expected: { readonly amount: PaymentMonetaryAmount; readonly operationId: OperationId };
  readonly observedAt: ProviderEvidence['observedAt'];
  readonly transId: ProviderObjectId;
}

/**
 * `code 0` is ACKNOWLEDGED / ACCEPTED_PENDING with REFUND_PENDING evidence only (N10): its observed
 * amount is the exact amount Comgate acknowledged in this request, and its effect key is
 * `comgate-refund:<transId>:<operationId>`. 1400/1401/1402 are REJECTED_BEFORE_EFFECT with
 * REFUND_NOT_EFFECTED. Any other code (1100, 1200, 1500, undocumented) and an unreadable body do not
 * prove either way: OutcomeUnknown, never success and never NOT_EFFECTED.
 */
export const mapComgateRefundResponse = (
  input: ComgateRefundResponseInput,
): Effect.Effect<ProviderDispatchResponse, GatewayProviderOutcomeUnknownError> => {
  const { expected, transId } = input;
  const decoded = Schema.decodeUnknownOption(ComgateResultResponseFromJsonSchema)(input.bodyText);
  if (Option.isNone(decoded)) {
    return Effect.fail(outcomeUnknown(expected.operationId, 'comgate_refund_response_unreadable'));
  }
  const { code } = decoded.value;
  if (code === COMGATE_SUCCESS_CODE) {
    return Effect.succeed({
      _tag: 'ACKNOWLEDGED',
      finding: makeFinding({
        evidence: Option.some(
          makeEvidence({
            amountMinor: expected.amount.amountMinor,
            discrepancy: Option.none(),
            economicEffectKey: Option.some(comgateRefundEffectKey(transId, expected.operationId)),
            factKind: 'REFUND_PENDING',
            observedAmount: Option.some(expected.amount),
            observedAt: input.observedAt,
            operationId: expected.operationId,
            origin: 'response',
            transId: Option.some(transId),
          }),
        ),
        finding: 'ACCEPTED_PENDING',
        operationId: expected.operationId,
        operationKind: 'REFUND',
        orderReference: Option.none(),
        transId: Option.some(transId),
      }),
      targetFinding: Option.none(),
    });
  }
  if (COMGATE_REFUND_REFUSED_CODES.includes(code)) {
    return Effect.succeed({
      _tag: 'REJECTED_BEFORE_EFFECT',
      finding: makeFinding({
        evidence: Option.some(
          makeEvidence({
            amountMinor: expected.amount.amountMinor,
            discrepancy: Option.none(),
            economicEffectKey: Option.none(),
            factKind: 'REFUND_NOT_EFFECTED',
            observedAmount: Option.none(),
            observedAt: input.observedAt,
            operationId: expected.operationId,
            origin: 'response',
            transId: Option.some(transId),
          }),
        ),
        finding: 'NOT_EFFECTED',
        operationId: expected.operationId,
        operationKind: 'REFUND',
        orderReference: Option.none(),
        transId: Option.some(transId),
      }),
      targetFinding: Option.none(),
    });
  }
  return Effect.fail(outcomeUnknown(expected.operationId, `comgate_refund_code_${code}`));
};

/* ------------------------------------------------------------------------------------------------ */
/* Status lookup (GET /v2.0/payment/transId/{id}.json)                                               */
/* ------------------------------------------------------------------------------------------------ */

/** A status answer that matched the binding and the looked-up transaction. */
const VerifiedStatusSchema = Schema.Struct({
  observedAmount: ProviderReportedAmountSchema,
  refId: Schema.Option(GatewayOrderReferenceSchema),
  status: Schema.Option(ComgatePaymentStatusSchema),
});
type VerifiedStatus = typeof VerifiedStatusSchema.Type;

const StatusCheckSchema = Schema.Union([
  Schema.TaggedStruct('CONFLICT', {}),
  Schema.TaggedStruct('INVALID', {}),
  Schema.TaggedStruct('VERIFIED', { verified: VerifiedStatusSchema }),
]);
type StatusCheck = typeof StatusCheckSchema.Type;

/** `test`, `merchant` (when present) and `transId` must match; `price` must parse exactly. */
const checkFound = (
  found: ComgateStatusFound,
  binding: ComgateBindingIdentity,
  transId: ProviderObjectId,
): StatusCheck => {
  const observedAmount = fromComgatePrice(found);
  if (Option.isNone(observedAmount)) {
    return { _tag: 'INVALID' };
  }
  const merchantMatches = found.merchant === undefined || found.merchant === binding.merchantId;
  if (found.transId !== transId || found.test !== binding.test || !merchantMatches) {
    return { _tag: 'CONFLICT' };
  }
  return {
    _tag: 'VERIFIED',
    verified: {
      observedAmount: observedAmount.value,
      refId: Schema.decodeUnknownOption(GatewayOrderReferenceSchema)(found.refId),
      status: Schema.decodeUnknownOption(ComgatePaymentStatusSchema)(found.status),
    },
  };
};

/**
 * The lookup-verified `refId` for correlation (plan §2.3 step 2): present only for a `code 0` answer
 * about this transId whose `test` flag and merchant match the binding and whose refId is an OntOS order
 * reference. Anything else is `None` (the notification stays uncorrelated).
 */
export const comgateVerifiedOrderReference = (input: {
  readonly answer: ComgateStatusAnswer;
  readonly binding: ComgateBindingIdentity;
  readonly transId: ProviderObjectId;
}): Option.Option<GatewayOrderReference> =>
  Match.value(input.answer).pipe(
    Match.tag('FOUND', ({ status }) =>
      Match.value(checkFound(status, input.binding, input.transId)).pipe(
        Match.tag('VERIFIED', ({ verified }) => verified.refId),
        Match.orElse(() => Option.none()),
      ),
    ),
    Match.orElse(() => Option.none()),
  );

/** The verified lookup status, for comparison with a pushed status. `None` when the lookup proves nothing. */
export const comgateVerifiedStatus = (input: {
  readonly answer: ComgateStatusAnswer;
  readonly binding: ComgateBindingIdentity;
  readonly transId: ProviderObjectId;
}): Option.Option<ComgatePaymentStatus> =>
  Match.value(input.answer).pipe(
    Match.tag('FOUND', ({ status }) =>
      Match.value(checkFound(status, input.binding, input.transId)).pipe(
        Match.tag('VERIFIED', ({ verified }) => verified.status),
        Match.orElse(() => Option.none()),
      ),
    ),
    Match.orElse(() => Option.none()),
  );

export interface ComgateStatusInput {
  readonly answer: ComgateStatusAnswer;
  readonly binding: ComgateBindingIdentity;
  readonly expected: GatewayExpectedEffect;
  readonly observedAt: ProviderEvidence['observedAt'];
  readonly transId: ProviderObjectId;
}

interface CollectionContext {
  readonly amount: PaymentMonetaryAmount;
  readonly observedAt: ProviderEvidence['observedAt'];
  readonly operationId: OperationId;
  readonly transId: ProviderObjectId;
  readonly verified: VerifiedStatus;
}

const collectionFact = (status: ComgatePaymentStatus): Option.Option<ProviderEvidenceFactKind> =>
  Match.value(status).pipe(
    Match.when('PENDING', () => Option.some<ProviderEvidenceFactKind>('COLLECTION_PENDING')),
    Match.when('PAID', () => Option.some<ProviderEvidenceFactKind>('COLLECTION_CONFIRMED')),
    Match.when('CANCELLED', () => Option.some<ProviderEvidenceFactKind>('COLLECTION_NOT_EFFECTED')),
    Match.when('AUTHORIZED', () => Option.none()),
    Match.exhaustive,
  );

const collectionFinding = (factKind: ProviderEvidenceFactKind): ProviderFinding =>
  Match.value(factKind).pipe(
    Match.when('COLLECTION_CONFIRMED', (): ProviderFinding => 'EFFECT_CONFIRMED'),
    Match.when('COLLECTION_NOT_EFFECTED', (): ProviderFinding => 'NOT_EFFECTED'),
    Match.orElse((): ProviderFinding => 'ACCEPTED_PENDING'),
  );

/**
 * One collection's finding from a verified status. PENDING/PAID/CANCELLED map to COLLECTION_PENDING /
 * COLLECTION_CONFIRMED / COLLECTION_NOT_EFFECTED; an amount or currency mismatch turns any of them into
 * VERIFICATION_CONFLICT with the discrepancy on the evidence. AUTHORIZED (preauthorization must never
 * happen) is VERIFICATION_CONFLICT; an undocumented status is INDETERMINATE. Neither has evidence.
 */
const collectionResult = (context: CollectionContext): ProviderFindingResult => {
  const base = {
    operationId: context.operationId,
    operationKind: 'COLLECT' as const,
    orderReference: context.verified.refId,
    transId: Option.some(context.transId),
  };
  if (Option.isNone(context.verified.status)) {
    return makeFinding({ ...base, evidence: Option.none(), finding: 'INDETERMINATE' });
  }
  const factKind = collectionFact(context.verified.status.value);
  if (Option.isNone(factKind)) {
    return makeFinding({ ...base, evidence: Option.none(), finding: 'VERIFICATION_CONFLICT' });
  }
  const discrepancy = Match.value(compareObservedAmount(context.amount, context.verified.observedAmount)).pipe(
    Match.tag('MATCH', () => Option.none<ProviderAmountDiscrepancy>()),
    Match.tag('MISMATCH', ({ discrepancy: found }) => Option.some(found)),
    Match.exhaustive,
  );
  const evidence = makeEvidence({
    amountMinor: context.verified.observedAmount.amountMinor,
    discrepancy,
    economicEffectKey: factKind.value === 'COLLECTION_CONFIRMED' ? Option.some<string>(context.transId) : Option.none(),
    factKind: factKind.value,
    observedAmount: Option.some(context.verified.observedAmount),
    observedAt: context.observedAt,
    operationId: context.operationId,
    origin: 'lookup',
    transId: Option.some(context.transId),
  });
  return makeFinding({
    ...base,
    evidence: Option.some(evidence),
    finding: Option.isSome(discrepancy) ? 'VERIFICATION_CONFLICT' : collectionFinding(factKind.value),
  });
};

/**
 * The cancel operation's own finding from a verified status of its target: CANCELLED is CANCEL_CONFIRMED
 * (the payment can no longer be paid), PAID is CANCEL_NOT_EFFECTED (Comgate: an already paid payment must
 * be refunded), PENDING and undocumented statuses are INDETERMINATE, AUTHORIZED is VERIFICATION_CONFLICT.
 */
const cancelResult = (input: {
  readonly cancelOperationId: OperationId;
  readonly observedAt: ProviderEvidence['observedAt'];
  readonly targetAmount: PaymentMonetaryAmount;
  readonly transId: ProviderObjectId;
  readonly verified: VerifiedStatus;
}): ProviderFindingResult => {
  const base = {
    operationId: input.cancelOperationId,
    operationKind: 'CANCEL_OR_VOID' as const,
    orderReference: input.verified.refId,
    transId: Option.some(input.transId),
  };
  const withEvidence = (factKind: ProviderEvidenceFactKind, finding: ProviderFinding): ProviderFindingResult =>
    makeFinding({
      ...base,
      evidence: Option.some(
        makeEvidence({
          amountMinor: input.targetAmount.amountMinor,
          discrepancy: Option.none(),
          economicEffectKey: Option.none(),
          factKind,
          observedAmount: Option.none(),
          observedAt: input.observedAt,
          operationId: input.cancelOperationId,
          origin: 'lookup',
          transId: Option.some(input.transId),
        }),
      ),
      finding,
    });
  return Option.match(input.verified.status, {
    onNone: () => makeFinding({ ...base, evidence: Option.none(), finding: 'INDETERMINATE' }),
    onSome: (status) =>
      Match.value(status).pipe(
        Match.when('CANCELLED', () => withEvidence('CANCEL_CONFIRMED', 'EFFECT_CONFIRMED')),
        Match.when('PAID', () => withEvidence('CANCEL_NOT_EFFECTED', 'NOT_EFFECTED')),
        Match.when('PENDING', () => makeFinding({ ...base, evidence: Option.none(), finding: 'INDETERMINATE' })),
        Match.when('AUTHORIZED', () =>
          makeFinding({ ...base, evidence: Option.none(), finding: 'VERIFICATION_CONFLICT' }),
        ),
        Match.exhaustive,
      ),
  });
};

const kindOf = (expected: GatewayExpectedEffect): PaymentOperationKind =>
  Match.value(expected).pipe(
    Match.tag('COLLECT', (): PaymentOperationKind => 'COLLECT'),
    Match.tag('REFUND', (): PaymentOperationKind => 'REFUND'),
    Match.tag('CANCEL_OR_VOID', (): PaymentOperationKind => 'CANCEL_OR_VOID'),
    Match.exhaustive,
  );

/** The collection operation whose `refId` the looked-up transaction must carry, if the expectation names one. */
const collectionOperationOf = (expected: GatewayExpectedEffect): Option.Option<OperationId> =>
  Match.value(expected).pipe(
    Match.tag('COLLECT', ({ operationId }) => Option.some(operationId)),
    Match.tag('CANCEL_OR_VOID', ({ target }) => Option.some(target.operationId)),
    Match.tag('REFUND', () => Option.none<OperationId>()),
    Match.exhaustive,
  );

const onlyFinding = (
  expected: GatewayExpectedEffect,
  finding: ProviderFinding,
  transId: ProviderObjectId,
  orderReference: Option.Option<GatewayOrderReference>,
): readonly ProviderFindingResult[] => {
  const own = makeFinding({
    evidence: Option.none(),
    finding,
    operationId: expected.operationId,
    operationKind: kindOf(expected),
    orderReference,
    transId: Option.some(transId),
  });
  return Match.value(expected).pipe(
    Match.tag('CANCEL_OR_VOID', ({ target }) =>
      finding === 'VERIFICATION_CONFLICT'
        ? [
            own,
            makeFinding({
              evidence: Option.none(),
              finding,
              operationId: target.operationId,
              operationKind: 'COLLECT',
              orderReference,
              transId: Option.some(transId),
            }),
          ]
        : [own],
    ),
    Match.orElse(() => [own]),
  );
};

const verifiedFindings = (input: ComgateStatusInput, verified: VerifiedStatus): readonly ProviderFindingResult[] => {
  const collectionOperation = collectionOperationOf(input.expected);
  const refIdMatches = Option.match(collectionOperation, {
    onNone: () => true,
    onSome: (operationId) => Option.contains(verified.refId, deriveProviderCorrelation(operationId).orderReference),
  });
  if (!refIdMatches) {
    return onlyFinding(input.expected, 'VERIFICATION_CONFLICT', input.transId, Option.none());
  }
  return Match.value(input.expected).pipe(
    Match.tag('COLLECT', ({ amount, operationId }) => [
      collectionResult({ amount, observedAt: input.observedAt, operationId, transId: input.transId, verified }),
    ]),
    Match.tag('CANCEL_OR_VOID', ({ operationId, target }) => [
      cancelResult({
        cancelOperationId: operationId,
        observedAt: input.observedAt,
        targetAmount: target.amount,
        transId: input.transId,
        verified,
      }),
      collectionResult({
        amount: target.amount,
        observedAt: input.observedAt,
        operationId: target.operationId,
        transId: input.transId,
        verified,
      }),
    ]),
    Match.tag('REFUND', () => onlyFinding(input.expected, 'INDETERMINATE', input.transId, verified.refId)),
    Match.exhaustive,
  );
};

/**
 * Maps one status answer to findings for exactly the operations named by `expected` (#1156, #1158):
 * - PROVIDER_ERROR (not found, unauthorized, any non-zero code): INDETERMINATE, never NOT_EFFECTED.
 * - INVALID (unreadable, or `code 0` with a missing field or an inexact `price`): ResponseInvalid.
 * - FOUND for another transId, environment (`test`) or merchant, or whose `refId` is not the expected
 *   collection's order reference: VERIFICATION_CONFLICT without evidence.
 * - COLLECT: the collection table (see `collectionResult`).
 * - CANCEL_OR_VOID: the cancel's finding (see `cancelResult`) plus the target collection's finding.
 * - REFUND: INDETERMINATE without evidence: the status exposes no refund state, so it never proves a
 *   refund confirmed or not effected (N10). The adapter answers a refund lookup from the settlement
 *   statement instead (`mapComgateStatementRefund`).
 */
export const mapComgateStatus = (
  input: ComgateStatusInput,
): Effect.Effect<readonly ProviderFindingResult[], GatewayProviderResponseInvalidError> =>
  Match.value(input.answer).pipe(
    Match.tag('INVALID', () => Effect.fail(responseInvalid('comgate_status_response_invalid'))),
    Match.tag('PROVIDER_ERROR', () =>
      Effect.succeed(onlyFinding(input.expected, 'INDETERMINATE', input.transId, Option.none())),
    ),
    Match.tag('FOUND', ({ status: found }) =>
      Match.value(checkFound(found, input.binding, input.transId)).pipe(
        Match.tag('INVALID', () => Effect.fail(responseInvalid('comgate_status_price_invalid'))),
        Match.tag('CONFLICT', () =>
          Effect.succeed(onlyFinding(input.expected, 'VERIFICATION_CONFLICT', input.transId, Option.none())),
        ),
        Match.tag('VERIFIED', ({ verified }) => Effect.succeed(verifiedFindings(input, verified))),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

/* ------------------------------------------------------------------------------------------------ */
/* Settlement statement (transferList + singleTransfer, production only)                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Why a statement lookup proved nothing (or found a contradiction). Logged by the adapter; the finding
 * contract carries no reason, so recovery records the INDETERMINATE step as `provider_indeterminate`.
 */
export const COMGATE_STATEMENT_REASONS = {
  ambiguous: 'refund_statement_rows_ambiguous',
  amountMismatch: 'refund_statement_amount_mismatch',
  dispatchTimeUnknown: 'refund_dispatch_time_unknown',
  notADebit: 'refund_statement_row_not_a_debit',
  notInStatement: 'refund_not_in_statement',
  notYetAvailable: 'statement_not_yet_available',
  testMode: 'statement_unavailable_in_test_mode',
} as const;
export type ComgateStatementReason = (typeof COMGATE_STATEMENT_REASONS)[keyof typeof COMGATE_STATEMENT_REASONS];

/** One statement row of the binding merchant whose `ID od klienta` is the refund's order reference. */
export interface ComgateStatementCandidate {
  /** `Potvrzená částka` as signed integer minor units (a refund row is negative). */
  readonly confirmedAmountMinor: number;
  /** `Datum založení` (Prague) as an instant; `None` when the wall-clock time is ambiguous around a DST change. */
  readonly createdAt: Option.Option<DateTime.Utc>;
  readonly currency: string;
  readonly transferId: ComgateTransferId;
}

/** The finding of a statement lookup and, when it settled nothing or conflicts, why. */
export interface ComgateStatementVerdict {
  readonly findings: readonly ProviderFindingResult[];
  readonly reason: Option.Option<ComgateStatementReason>;
}

interface StatementRefundSubject {
  readonly expected: { readonly amount: PaymentMonetaryAmount; readonly operationId: OperationId };
  readonly transId: ProviderObjectId;
}

const statementFinding = (
  subject: StatementRefundSubject,
  finding: ProviderFinding,
  evidence: Option.Option<ProviderEvidence>,
  orderReference: Option.Option<GatewayOrderReference>,
): ProviderFindingResult =>
  makeFinding({
    evidence,
    finding,
    operationId: subject.expected.operationId,
    operationKind: 'REFUND',
    orderReference,
    transId: Option.some(subject.transId),
  });

/** A refund lookup that read no statement row it could act on: INDETERMINATE, never NOT_EFFECTED (#1158). */
export const comgateStatementIndeterminate = (
  subject: StatementRefundSubject,
  reason: ComgateStatementReason,
): ComgateStatementVerdict => ({
  findings: [statementFinding(subject, 'INDETERMINATE', Option.none(), Option.none())],
  reason: Option.some(reason),
});

/**
 * The candidate rows of one transfer for one refund: rows whose `Merchant` is the binding merchant
 * (#1157, the original binding only) and whose `ID od klienta` is exactly the refund's order reference
 * (the per-operation `refId` sent with the refund, https://apidoc.comgate.cz/en/api/rest/ refund
 * `refId`: "the daily csv for the refund ... Client ID"). Every other row is ignored unread. A selected
 * row that does not decode strictly (amount, currency, time) proves nothing: ResponseInvalid.
 */
export const comgateStatementCandidatesOf = (input: {
  readonly binding: ComgateBindingIdentity;
  readonly orderReference: GatewayOrderReference;
  readonly rows: readonly ComgateStatementRawRow[];
  readonly transferId: ComgateTransferId;
}): Effect.Effect<readonly ComgateStatementCandidate[], GatewayProviderResponseInvalidError> => {
  const selected = input.rows.filter((row) =>
    Option.match(Schema.decodeUnknownOption(ComgateStatementRowKeySchema)(row), {
      onNone: () => false,
      onSome: (key) => key.Merchant === input.binding.merchantId && key['ID od klienta'] === input.orderReference,
    }),
  );
  const candidateOf = (
    row: ComgateStatementRawRow,
  ): Effect.Effect<ComgateStatementCandidate, GatewayProviderResponseInvalidError> => {
    const candidate = Schema.decodeUnknownOption(ComgateStatementRowSchema)(row).pipe(
      Option.flatMap((decoded) =>
        Option.all({
          confirmedAmountMinor: parseComgateStatementAmount(decoded['Potvrzená částka']),
          wallClock: parseComgatePragueWallClock(decoded['Datum založení']),
        }).pipe(
          Option.map(({ confirmedAmountMinor, wallClock }): ComgateStatementCandidate => ({
            confirmedAmountMinor,
            createdAt: pragueWallClockToUtc(wallClock),
            currency: decoded.Měna,
            transferId: input.transferId,
          })),
        ),
      ),
    );
    return Effect.fromOption(candidate).pipe(
      Effect.catchTag('NoSuchElementError', () => Effect.fail(responseInvalid('comgate_statement_row_invalid'))),
    );
  };
  return Effect.forEach(selected, candidateOf, { concurrency: 1 });
};

/**
 * A refund's finding from every candidate statement row found for it (plan D-P2, #1156, #1158, #1159):
 * - no row: INDETERMINATE `refund_not_in_statement` (a queued refund may still be waiting for funds;
 *   absence never proves NOT_EFFECTED);
 * - more than one row: VERIFICATION_CONFLICT without evidence (one refund operation has one refId);
 * - one row that is not a debit (zero or positive, e.g. an undocumented reversal): VERIFICATION_CONFLICT
 *   without evidence; it neither confirms nor disproves the refund;
 * - one debit row of exactly the refund amount and currency: EFFECT_CONFIRMED with REFUND_CONFIRMED
 *   evidence. It proves Comgate executed the refund against the merchant's settlement, not that the
 *   payer's bank accepted it;
 * - one debit row of another amount or currency: VERIFICATION_CONFLICT with REFUND_CONFIRMED evidence
 *   carrying the discrepancy and the authentic statement amount.
 * Occurrence `comgate:statement:<transferId>:<operationId>:REFUND_CONFIRMED:<amountMinor>`, effect key
 * `comgate-refund:<transId>:<operationId>`, provider instant = the row's `Datum založení`.
 */
export const mapComgateStatementRefund = (
  input: StatementRefundSubject & {
    readonly candidates: readonly ComgateStatementCandidate[];
    readonly observedAt: ProviderEvidence['observedAt'];
  },
): ComgateStatementVerdict => {
  const [only, ...others] = input.candidates;
  if (only === undefined) {
    return comgateStatementIndeterminate(input, COMGATE_STATEMENT_REASONS.notInStatement);
  }
  const verifiedReference = Option.some(deriveProviderCorrelation(input.expected.operationId).orderReference);
  const conflict = (reason: ComgateStatementReason): ComgateStatementVerdict => ({
    findings: [statementFinding(input, 'VERIFICATION_CONFLICT', Option.none(), verifiedReference)],
    reason: Option.some(reason),
  });
  if (others.length > 0) {
    return conflict(COMGATE_STATEMENT_REASONS.ambiguous);
  }
  const observed = Schema.decodeUnknownOption(ProviderReportedAmountSchema)({
    amountMinor: -only.confirmedAmountMinor,
    currency: only.currency,
  });
  if (only.confirmedAmountMinor >= 0 || Option.isNone(observed)) {
    return conflict(COMGATE_STATEMENT_REASONS.notADebit);
  }
  const discrepancy = Match.value(compareObservedAmount(input.expected.amount, observed.value)).pipe(
    Match.tag('MATCH', () => Option.none<ProviderAmountDiscrepancy>()),
    Match.tag('MISMATCH', ({ discrepancy: found }) => Option.some(found)),
    Match.exhaustive,
  );
  const evidence = makeEvidence({
    amountMinor: observed.value.amountMinor,
    discrepancy,
    economicEffectKey: Option.some(comgateRefundEffectKey(input.transId, input.expected.operationId)),
    factKind: 'REFUND_CONFIRMED',
    observedAmount: observed,
    observedAt: input.observedAt,
    occurrenceObjectId: `${only.transferId}`,
    operationId: input.expected.operationId,
    origin: 'statement',
    providerOccurredAt: only.createdAt,
    transId: Option.some(input.transId),
  });
  const confirmed = Option.isNone(discrepancy);
  return {
    findings: [
      statementFinding(
        input,
        confirmed ? 'EFFECT_CONFIRMED' : 'VERIFICATION_CONFLICT',
        Option.some(evidence),
        verifiedReference,
      ),
    ],
    reason: confirmed ? Option.none() : Option.some(COMGATE_STATEMENT_REASONS.amountMismatch),
  };
};
