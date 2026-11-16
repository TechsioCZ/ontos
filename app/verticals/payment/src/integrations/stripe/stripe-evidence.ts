import { Effect, Match, Option, Schema } from 'effect';
import type { DateTime } from 'effect';

import {
  PaymentEconomicEffectKeySchema,
  PaymentSourceOccurrenceIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayHttpsUrl } from '../../../shared/domain/psp-configuration.ts';
import { ProviderEvidenceOriginSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type {
  GatewayEnvironment,
  ProviderEvidenceFactKind,
  ProviderFinding,
} from '../../../shared/domain/psp-vocabulary.ts';
import { deriveProviderCorrelation } from '../psp/psp-correlation.ts';
import type { GatewayOrderReference } from '../psp/psp-correlation.ts';
import { GatewayProviderResponseInvalid } from '../psp/psp-errors.ts';
import type { GatewayProviderResponseInvalidError } from '../psp/psp-errors.ts';
import { compareObservedAmount, ProviderReportedAmountSchema } from '../psp/psp-money.ts';
import type { ProviderAmountDiscrepancy, ProviderReportedAmount } from '../psp/psp-money.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';
import type { GatewayExpectedEffect, ProviderObjectId, ProviderObjectRef } from '../psp/psp-request.ts';
import type { ProviderEvidence, ProviderFindingResult } from '../psp/psp-result.ts';
import { fromStripeAmount } from './stripe-money.ts';
import { stripeExpandedPaymentIntentOf, stripeOrderReferenceOf, stripePaymentIntentIdOf } from './stripe-wire.ts';
import type {
  StripeCheckoutSession,
  StripePaymentIntent,
  StripePaymentIntentSearchResult,
  StripeRefund,
} from './stripe-wire.ts';

/**
 * Stripe state mapping to provider-neutral findings and evidence (#1156, #1158), plan §4 Stripe:
 * - PaymentIntent `succeeded` with a validated `amount_received`/`currency` is COLLECTION_CONFIRMED; any
 *   amount or currency difference is VERIFICATION_CONFLICT with the discrepancy, never a confirmation.
 * - `canceled`, or an `expired` session whose PaymentIntent is absent or not succeeded, is
 *   COLLECTION_NOT_EFFECTED. An expired session whose PaymentIntent was not expanded proves nothing.
 * - `requires_capture` is a hold OntOS never requested (capture is automatic): VERIFICATION_CONFLICT.
 * - Refund `pending`/`requires_action` is REFUND_PENDING, `succeeded` REFUND_CONFIRMED, `failed`/`canceled`
 *   REFUND_NOT_EFFECTED. A later contrary state is a new occurrence of the contrary fact (the fact kind is
 *   part of the occurrence id), never a SOURCE_CORRECTION.
 * - A 404 or a search miss is INDETERMINATE, never NOT_EFFECTED.
 * - `livemode` must match the binding environment, otherwise the response is invalid for this binding.
 * Findings are emitted only for `expected.operationId` and, for CANCEL_OR_VOID, `expected.target.operationId`.
 */

const StripeObservationOriginSchema = ProviderEvidenceOriginSchema.pick([
  'DISPATCH_RESPONSE',
  'NOTIFICATION_LOOKUP',
  'RECOVERY_LOOKUP',
  'RECOVERY_REPLAY',
]);
/** The `<origin>` segment of `stripe:<origin>:<providerObjectId>:<operationId>:<factKind>:<amountMinor>`. */
export type StripeObservationOrigin = typeof StripeObservationOriginSchema.Type;

type PaymentOperationId = typeof PaymentOperationIdSchema.Type;
type PaymentPositiveMonetaryAmount = typeof PaymentPositiveMonetaryAmountSchema.Type;
type ExpectedOf<Tag extends GatewayExpectedEffect['_tag']> = Extract<GatewayExpectedEffect, { readonly _tag: Tag }>;
export type StripeCollectionExpectation = ExpectedOf<'COLLECT' | 'CANCEL_OR_VOID'>;
export type StripeCancelExpectation = ExpectedOf<'CANCEL_OR_VOID'>;
export type StripeRefundExpectation = ExpectedOf<'REFUND'>;

export interface StripeObservationContext<Expected extends GatewayExpectedEffect> {
  readonly environment: GatewayEnvironment;
  readonly expected: Expected;
  /** When OntOS received the response that is mapped (Effect Clock right after decoding). */
  readonly observedAt: DateTime.Utc;
  readonly origin: StripeObservationOrigin;
}

type AnyContext = StripeObservationContext<GatewayExpectedEffect>;
type CollectionContext = StripeObservationContext<StripeCollectionExpectation>;

const responseInvalid = (reason: string): GatewayProviderResponseInvalidError =>
  new GatewayProviderResponseInvalid({ code: 'gateway_provider_response_invalid', family: 'STRIPE', reason });

const requireLivemode = (
  environment: GatewayEnvironment,
  livemode: boolean,
): Effect.Effect<void, GatewayProviderResponseInvalidError> =>
  livemode === (environment === 'LIVE') ? Effect.void : Effect.fail(responseInvalid('stripe_livemode_mismatch'));

const FACT_FAMILY_OF = {
  CANCEL_CONFIRMED: 'GATEWAY_OUTCOME',
  CANCEL_NOT_EFFECTED: 'GATEWAY_OUTCOME',
  COLLECTION_CONFIRMED: 'GATEWAY_OUTCOME',
  COLLECTION_NOT_EFFECTED: 'GATEWAY_OUTCOME',
  COLLECTION_PENDING: 'GATEWAY_OUTCOME',
  REFUND_CONFIRMED: 'REFUND_EXECUTION',
  REFUND_INDETERMINATE: 'REFUND_EXECUTION',
  REFUND_NOT_EFFECTED: 'REFUND_EXECUTION',
  REFUND_PENDING: 'REFUND_EXECUTION',
} as const satisfies Record<ProviderEvidenceFactKind, ProviderEvidence['factFamily']>;

/** The operation a finding is about, with the amount its evidence must prove. */
interface FindingSubject {
  readonly expectedAmount: PaymentPositiveMonetaryAmount;
  readonly operationId: PaymentOperationId;
  readonly operationKind: GatewayExpectedEffect['_tag'];
  readonly orderReference: Option.Option<GatewayOrderReference>;
  readonly providerRefs: readonly ProviderObjectRef[];
}

interface EvidenceFacts {
  readonly discrepancy: Option.Option<ProviderAmountDiscrepancy>;
  readonly factKind: ProviderEvidenceFactKind;
  /** The provider object the fact is about; also the economic effect key. */
  readonly objectId: ProviderObjectId;
  readonly observedAmount: Option.Option<ProviderReportedAmount>;
  readonly reason: Option.Option<string>;
}

const EvidenceIdentitySchema = Schema.Struct({
  economicEffectKey: PaymentEconomicEffectKeySchema,
  sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
});

const evidenceOf = Effect.fn('StripeEvidence.evidenceOf')(function* evidenceOf(
  context: AnyContext,
  subject: FindingSubject,
  facts: EvidenceFacts,
) {
  const amountMinor = facts.observedAmount.pipe(
    Option.map((observed) => observed.amountMinor),
    Option.getOrElse(() => subject.expectedAmount.amountMinor),
  );
  const identity = yield* Schema.decodeUnknownEffect(EvidenceIdentitySchema)({
    economicEffectKey: facts.objectId,
    sourceOccurrenceId: `stripe:${context.origin}:${facts.objectId}:${subject.operationId}:${facts.factKind}:${amountMinor}`,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(responseInvalid('stripe_evidence_identity_invalid'))));
  const evidence: ProviderEvidence = {
    discrepancy: facts.discrepancy,
    economicEffectKey: Option.some(identity.economicEffectKey),
    factFamily: FACT_FAMILY_OF[facts.factKind],
    factKind: facts.factKind,
    observedAmount: facts.observedAmount,
    observedAt: context.observedAt,
    providerOccurredAt: Option.none(),
    providerRefs: subject.providerRefs,
    reason: facts.reason,
    sourceOccurrenceId: identity.sourceOccurrenceId,
    sourceRevision: 0,
  };
  return evidence;
});

const findingOf = (
  subject: FindingSubject,
  finding: ProviderFinding,
  evidence: Option.Option<ProviderEvidence>,
  redirectUrl: Option.Option<GatewayHttpsUrl> = Option.none(),
): ProviderFindingResult => ({
  customerAction: redirectUrl.pipe(Option.map((url) => ({ redirectUrl: url }))),
  evidence,
  finding,
  orderReference: subject.orderReference,
  providerRefs: subject.providerRefs,
  target: { operationId: subject.operationId, operationKind: subject.operationKind },
});

const discrepancyOf = (
  expected: PaymentPositiveMonetaryAmount,
  reported: ProviderReportedAmount,
): Option.Option<ProviderAmountDiscrepancy> =>
  Match.value(compareObservedAmount(expected, reported)).pipe(
    Match.tag('MATCH', () => Option.none<ProviderAmountDiscrepancy>()),
    Match.tag('MISMATCH', ({ discrepancy }) => Option.some(discrepancy)),
    Match.exhaustive,
  );

/** A fact that carries an amount: it agrees only when amount and currency match exactly. */
const amountFinding = Effect.fn('StripeEvidence.amountFinding')(function* amountFinding(
  context: AnyContext,
  subject: FindingSubject,
  observed: {
    readonly agreed: ProviderFinding;
    readonly factKind: ProviderEvidenceFactKind;
    readonly objectId: ProviderObjectId;
    readonly reported: ProviderReportedAmount;
  },
) {
  const discrepancy = discrepancyOf(subject.expectedAmount, observed.reported);
  const evidence = yield* evidenceOf(context, subject, {
    discrepancy,
    factKind: observed.factKind,
    objectId: observed.objectId,
    observedAmount: Option.some(observed.reported),
    reason: discrepancy.pipe(Option.map(() => 'stripe_amount_mismatch')),
  });
  return findingOf(
    subject,
    Option.isSome(discrepancy) ? 'VERIFICATION_CONFLICT' : observed.agreed,
    Option.some(evidence),
  );
});

/** A fact without a moved amount (not effected, cancel). */
const plainFinding = Effect.fn('StripeEvidence.plainFinding')(function* plainFinding(
  context: AnyContext,
  subject: FindingSubject,
  observed: {
    readonly factKind: ProviderEvidenceFactKind;
    readonly finding: ProviderFinding;
    readonly objectId: ProviderObjectId;
    readonly reason: Option.Option<string>;
  },
) {
  const evidence = yield* evidenceOf(context, subject, {
    discrepancy: Option.none(),
    factKind: observed.factKind,
    objectId: observed.objectId,
    observedAmount: Option.none(),
    reason: observed.reason,
  });
  return findingOf(subject, observed.finding, Option.some(evidence));
});

/** A 404 or a PaymentIntent search miss: the provider proved nothing, so the expected operation stays open. */
export const mapStripeLookupMiss = (expected: GatewayExpectedEffect): readonly ProviderFindingResult[] => [
  {
    customerAction: Option.none(),
    evidence: Option.none(),
    finding: 'INDETERMINATE',
    orderReference: Option.none(),
    providerRefs: [],
    target: { operationId: expected.operationId, operationKind: expected._tag },
  },
];

// ---------------------------------------------------------------------------------------------------
// Collections (Checkout Session and PaymentIntent)
// ---------------------------------------------------------------------------------------------------

const CollectionStateSchema = Schema.Union([
  Schema.TaggedStruct('CONFIRMED', { paymentIntentId: ProviderObjectIdSchema, reported: ProviderReportedAmountSchema }),
  Schema.TaggedStruct('PENDING', { paymentIntentId: ProviderObjectIdSchema, reported: ProviderReportedAmountSchema }),
  Schema.TaggedStruct('NOT_EFFECTED', { objectId: ProviderObjectIdSchema, reason: Schema.String }),
  Schema.TaggedStruct('AWAITING_CUSTOMER', { redirectUrl: Schema.Option(GatewayHttpsUrlSchema) }),
  Schema.TaggedStruct('HELD_FOR_CAPTURE', {}),
  Schema.TaggedStruct('UNRESOLVED', {}),
  Schema.TaggedStruct('FOREIGN', {}),
]);
type CollectionState = typeof CollectionStateSchema.Type;

const UNRESOLVED: CollectionState = { _tag: 'UNRESOLVED' };
const FOREIGN: CollectionState = { _tag: 'FOREIGN' };

interface CollectionObservation {
  /** Session id, else PaymentIntent id: the object a cancel fact is about. */
  readonly primaryObjectId: ProviderObjectId;
  readonly providerRefs: readonly ProviderObjectRef[];
  readonly state: CollectionState;
  readonly verifiedOrderReference: Option.Option<GatewayOrderReference>;
}

const collectionOperationOf = (expected: StripeCollectionExpectation) =>
  Match.value(expected).pipe(
    Match.tag('COLLECT', ({ amount, operationId }) => ({ amount, operationId })),
    Match.tag('CANCEL_OR_VOID', ({ target }) => target),
    Match.exhaustive,
  );

const reportedOf = (
  amountMinor: number,
  currency: string,
): Effect.Effect<ProviderReportedAmount, GatewayProviderResponseInvalidError> =>
  Effect.fromOption(fromStripeAmount(amountMinor, currency), () => responseInvalid('stripe_amount_invalid'));

const paymentIntentState = (
  paymentIntent: StripePaymentIntent,
): Effect.Effect<CollectionState, GatewayProviderResponseInvalidError> =>
  Match.value(paymentIntent.status).pipe(
    Match.when('succeeded', () =>
      Effect.map(reportedOf(paymentIntent.amount_received, paymentIntent.currency), (reported): CollectionState => ({
        _tag: 'CONFIRMED',
        paymentIntentId: paymentIntent.id,
        reported,
      })),
    ),
    Match.when('processing', () =>
      Effect.map(reportedOf(paymentIntent.amount, paymentIntent.currency), (reported): CollectionState => ({
        _tag: 'PENDING',
        paymentIntentId: paymentIntent.id,
        reported,
      })),
    ),
    Match.when('canceled', () =>
      Effect.succeed<CollectionState>({
        _tag: 'NOT_EFFECTED',
        objectId: paymentIntent.id,
        reason: 'stripe_payment_intent_canceled',
      }),
    ),
    Match.when('requires_capture', () => Effect.succeed<CollectionState>({ _tag: 'HELD_FOR_CAPTURE' })),
    Match.whenOr('requires_payment_method', 'requires_confirmation', 'requires_action', () =>
      Effect.succeed<CollectionState>({ _tag: 'AWAITING_CUSTOMER', redirectUrl: Option.none() }),
    ),
    Match.exhaustive,
  );

/** The claimed metadata order reference, kept only when it equals the collection's own. */
const verifiedOrderReferenceOf = (
  claimed: Option.Option<GatewayOrderReference>,
  collectionOperationId: PaymentOperationId,
): Option.Option<GatewayOrderReference> => {
  const own = deriveProviderCorrelation(collectionOperationId).orderReference;
  return claimed.pipe(Option.filter((reference) => reference === own));
};

const sessionState = Effect.fn('StripeEvidence.sessionState')(function* sessionState(session: StripeCheckoutSession) {
  const status = Option.getOrUndefined(session.status);
  const sessionUrl =
    status === 'open'
      ? Schema.decodeUnknownOption(GatewayHttpsUrlSchema)(Option.getOrUndefined(session.url))
      : Option.none<GatewayHttpsUrl>();
  const awaiting: CollectionState = { _tag: 'AWAITING_CUSTOMER', redirectUrl: sessionUrl };
  const expired: CollectionState = {
    _tag: 'NOT_EFFECTED',
    objectId: session.id,
    reason: 'stripe_checkout_session_expired',
  };
  const expanded = stripeExpandedPaymentIntentOf(session);
  if (Option.isNone(expanded)) {
    if (status === 'open') {
      return awaiting;
    }
    return status === 'expired' && Option.isNone(session.payment_intent) ? expired : UNRESOLVED;
  }
  const state = yield* paymentIntentState(expanded.value);
  return Match.value(state).pipe(
    Match.tag('AWAITING_CUSTOMER', (): CollectionState => (status === 'expired' ? expired : awaiting)),
    Match.tag('PENDING', (pending): CollectionState => (status === 'expired' ? expired : pending)),
    Match.orElse((other) => other),
  );
});

const observeSession = Effect.fn('StripeEvidence.observeSession')(function* observeSession(
  session: StripeCheckoutSession,
  context: CollectionContext,
) {
  yield* requireLivemode(context.environment, session.livemode);
  const expanded = stripeExpandedPaymentIntentOf(session);
  if (Option.isSome(expanded)) {
    yield* requireLivemode(context.environment, expanded.value.livemode);
  }
  const paymentIntentRefs: readonly ProviderObjectRef[] = Option.match(stripePaymentIntentIdOf(session), {
    onNone: () => [],
    onSome: (id) => [{ _tag: 'STRIPE_PAYMENT_INTENT', id }],
  });
  const providerRefs: readonly ProviderObjectRef[] = [
    { _tag: 'STRIPE_CHECKOUT_SESSION', id: session.id },
    ...paymentIntentRefs,
  ];
  const collectionOperationId = collectionOperationOf(context.expected).operationId;
  const verifiedOrderReference = verifiedOrderReferenceOf(
    stripeOrderReferenceOf(session.metadata),
    collectionOperationId,
  );
  const paymentIntentClaim = expanded.pipe(
    Option.flatMap((paymentIntent) => stripeOrderReferenceOf(paymentIntent.metadata)),
  );
  const paymentIntentForeign =
    Option.isSome(paymentIntentClaim) &&
    Option.isNone(verifiedOrderReferenceOf(paymentIntentClaim, collectionOperationId));
  const foreign = session.mode !== 'payment' || Option.isNone(verifiedOrderReference) || paymentIntentForeign;
  const observation: CollectionObservation = {
    primaryObjectId: session.id,
    providerRefs,
    state: foreign ? FOREIGN : yield* sessionState(session),
    verifiedOrderReference: foreign ? Option.none() : verifiedOrderReference,
  };
  return observation;
});

const observePaymentIntent = Effect.fn('StripeEvidence.observePaymentIntent')(function* observePaymentIntent(
  paymentIntent: StripePaymentIntent,
  context: CollectionContext,
) {
  yield* requireLivemode(context.environment, paymentIntent.livemode);
  const verifiedOrderReference = verifiedOrderReferenceOf(
    stripeOrderReferenceOf(paymentIntent.metadata),
    collectionOperationOf(context.expected).operationId,
  );
  const observation: CollectionObservation = {
    primaryObjectId: paymentIntent.id,
    providerRefs: [{ _tag: 'STRIPE_PAYMENT_INTENT', id: paymentIntent.id }],
    state: Option.isNone(verifiedOrderReference) ? FOREIGN : yield* paymentIntentState(paymentIntent),
    verifiedOrderReference,
  };
  return observation;
});

const collectionSubjectOf = (observation: CollectionObservation, context: CollectionContext): FindingSubject => {
  const { amount, operationId } = collectionOperationOf(context.expected);
  return {
    expectedAmount: amount,
    operationId,
    operationKind: 'COLLECT',
    orderReference: observation.verifiedOrderReference,
    providerRefs: observation.providerRefs,
  };
};

/** The finding about the collection operation itself (COLLECT, or the target of a CANCEL_OR_VOID). */
const collectionFinding = (
  observation: CollectionObservation,
  context: CollectionContext,
): Effect.Effect<ProviderFindingResult, GatewayProviderResponseInvalidError> => {
  const subject = collectionSubjectOf(observation, context);
  return Match.value(observation.state).pipe(
    Match.tag('CONFIRMED', ({ paymentIntentId, reported }) =>
      amountFinding(context, subject, {
        agreed: 'EFFECT_CONFIRMED',
        factKind: 'COLLECTION_CONFIRMED',
        objectId: paymentIntentId,
        reported,
      }),
    ),
    Match.tag('PENDING', ({ paymentIntentId, reported }) =>
      amountFinding(context, subject, {
        agreed: 'ACCEPTED_PENDING',
        factKind: 'COLLECTION_PENDING',
        objectId: paymentIntentId,
        reported,
      }),
    ),
    Match.tag('NOT_EFFECTED', ({ objectId, reason }) =>
      plainFinding(context, subject, {
        factKind: 'COLLECTION_NOT_EFFECTED',
        finding: 'NOT_EFFECTED',
        objectId,
        reason: Option.some(reason),
      }),
    ),
    Match.tag('AWAITING_CUSTOMER', ({ redirectUrl }) =>
      Effect.succeed(findingOf(subject, 'CUSTOMER_ACTION_REQUIRED', Option.none(), redirectUrl)),
    ),
    Match.tag('HELD_FOR_CAPTURE', 'FOREIGN', () =>
      Effect.succeed(findingOf(subject, 'VERIFICATION_CONFLICT', Option.none())),
    ),
    Match.tag('UNRESOLVED', () => Effect.succeed(findingOf(subject, 'INDETERMINATE', Option.none()))),
    Match.exhaustive,
  );
};

const cancelSubjectOf = (observation: CollectionObservation, expected: StripeCancelExpectation): FindingSubject => ({
  expectedAmount: expected.target.amount,
  operationId: expected.operationId,
  operationKind: 'CANCEL_OR_VOID',
  orderReference: observation.verifiedOrderReference,
  providerRefs: observation.providerRefs,
});

interface CancelVerdict {
  /** Present when the collection state proves the cancel outcome; then the target gets its own finding. */
  readonly fact: Option.Option<{
    readonly factKind: 'CANCEL_CONFIRMED' | 'CANCEL_NOT_EFFECTED';
    readonly reason: Option.Option<string>;
  }>;
  readonly finding: ProviderFinding;
}

const cancelVerdictOf = (state: CollectionState): CancelVerdict =>
  Match.value(state).pipe(
    Match.tag('CONFIRMED', (): CancelVerdict => ({
      fact: Option.some({ factKind: 'CANCEL_NOT_EFFECTED', reason: Option.some('stripe_collection_already_paid') }),
      finding: 'NOT_EFFECTED',
    })),
    Match.tag('PENDING', (): CancelVerdict => ({
      fact: Option.some({ factKind: 'CANCEL_NOT_EFFECTED', reason: Option.some('stripe_collection_in_progress') }),
      finding: 'NOT_EFFECTED',
    })),
    Match.tag('NOT_EFFECTED', (): CancelVerdict => ({
      fact: Option.some({ factKind: 'CANCEL_CONFIRMED', reason: Option.none() }),
      finding: 'EFFECT_CONFIRMED',
    })),
    Match.tag('AWAITING_CUSTOMER', 'UNRESOLVED', (): CancelVerdict => ({
      fact: Option.none(),
      finding: 'INDETERMINATE',
    })),
    Match.tag('HELD_FOR_CAPTURE', 'FOREIGN', (): CancelVerdict => ({
      fact: Option.none(),
      finding: 'VERIFICATION_CONFLICT',
    })),
    Match.exhaustive,
  );

const cancelFindings = Effect.fn('StripeEvidence.cancelFindings')(function* cancelFindings(
  observation: CollectionObservation,
  context: CollectionContext,
  expected: StripeCancelExpectation,
) {
  const subject = cancelSubjectOf(observation, expected);
  const verdict = cancelVerdictOf(observation.state);
  if (Option.isNone(verdict.fact)) {
    const findings: readonly ProviderFindingResult[] = [findingOf(subject, verdict.finding, Option.none())];
    return findings;
  }
  const findings: readonly ProviderFindingResult[] = yield* Effect.all(
    [
      plainFinding(context, subject, {
        factKind: verdict.fact.value.factKind,
        finding: verdict.finding,
        objectId: observation.primaryObjectId,
        reason: verdict.fact.value.reason,
      }),
      collectionFinding(observation, context),
    ],
    { concurrency: 1 },
  );
  return findings;
});

const collectionMapping = (
  observation: CollectionObservation,
  context: CollectionContext,
): Effect.Effect<readonly ProviderFindingResult[], GatewayProviderResponseInvalidError> =>
  Match.value(context.expected).pipe(
    Match.tag('COLLECT', () => Effect.map(collectionFinding(observation, context), (finding) => [finding])),
    Match.tag('CANCEL_OR_VOID', (expected) => cancelFindings(observation, context, expected)),
    Match.exhaustive,
  );

/**
 * A Checkout Session from the create response, a lookup (`expand[]=payment_intent`) or a replay. An open
 * session is CUSTOMER_ACTION_REQUIRED with its hosted `url`.
 */
export const mapStripeCheckoutSession = Effect.fn('StripeEvidence.mapStripeCheckoutSession')(
  function* mapStripeCheckoutSession(session: StripeCheckoutSession, context: CollectionContext) {
    const observation = yield* observeSession(session, context);
    return yield* collectionMapping(observation, context);
  },
);

/** A PaymentIntent from `GET /v1/payment_intents/{id}` or a search hit. */
export const mapStripePaymentIntent = Effect.fn('StripeEvidence.mapStripePaymentIntent')(
  function* mapStripePaymentIntent(paymentIntent: StripePaymentIntent, context: CollectionContext) {
    const observation = yield* observePaymentIntent(paymentIntent, context);
    return yield* collectionMapping(observation, context);
  },
);

/**
 * The 200 answer of `POST /v1/checkout/sessions/{id}/expire`. Stripe expires only an open session, so an
 * `expired` answer confirms the cancel; the collection is NOT_EFFECTED only when no PaymentIntent exists
 * (otherwise a lookup decides it). A "not open" error is not mapped here: the caller looks the session up.
 */
export const mapStripeExpireResponse = Effect.fn('StripeEvidence.mapStripeExpireResponse')(
  function* mapStripeExpireResponse(
    session: StripeCheckoutSession,
    context: StripeObservationContext<StripeCancelExpectation>,
  ) {
    const observation = yield* observeSession(session, context);
    const expiredByCall =
      Option.contains(session.status, 'expired') &&
      Match.value(observation.state).pipe(
        Match.tag('NOT_EFFECTED', 'UNRESOLVED', () => true),
        Match.orElse(() => false),
      );
    if (!expiredByCall) {
      return yield* cancelFindings(observation, context, context.expected);
    }
    const cancel = yield* plainFinding(context, cancelSubjectOf(observation, context.expected), {
      factKind: 'CANCEL_CONFIRMED',
      finding: 'EFFECT_CONFIRMED',
      objectId: session.id,
      reason: Option.none(),
    });
    if (Option.isSome(session.payment_intent)) {
      const findings: readonly ProviderFindingResult[] = [cancel];
      return findings;
    }
    const findings: readonly ProviderFindingResult[] = [cancel, yield* collectionFinding(observation, context)];
    return findings;
  },
);

/**
 * `GET /v1/payment_intents/search?query=metadata['ontos_order_reference']:'<orderReference>'`. Only hits whose
 * metadata carries exactly the collection's order reference count. The index is eventually consistent, so
 * no hit is INDETERMINATE; more than one is a VERIFICATION_CONFLICT (one collection has one PaymentIntent).
 */
export const mapStripePaymentIntentSearch = Effect.fn('StripeEvidence.mapStripePaymentIntentSearch')(
  function* mapStripePaymentIntentSearch(result: StripePaymentIntentSearchResult, context: CollectionContext) {
    const collectionOperationId = collectionOperationOf(context.expected).operationId;
    const hits = result.data.filter((paymentIntent) =>
      Option.isSome(verifiedOrderReferenceOf(stripeOrderReferenceOf(paymentIntent.metadata), collectionOperationId)),
    );
    const [first, ...others] = hits;
    if (first === undefined) {
      return mapStripeLookupMiss(context.expected);
    }
    if (others.length > 0) {
      const conflict: readonly ProviderFindingResult[] = [
        {
          customerAction: Option.none(),
          evidence: Option.none(),
          finding: 'VERIFICATION_CONFLICT',
          orderReference: Option.none(),
          providerRefs: hits.map((paymentIntent): ProviderObjectRef => ({
            _tag: 'STRIPE_PAYMENT_INTENT',
            id: paymentIntent.id,
          })),
          target: { operationId: context.expected.operationId, operationKind: context.expected._tag },
        },
      ];
      return conflict;
    }
    return yield* mapStripePaymentIntent(first, context);
  },
);

// ---------------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------------

/**
 * A Refund from `POST /v1/refunds` or `GET /v1/refunds/{id}`. The economic effect key is the refund id.
 * A refund that claims another operation's order reference in its metadata is a VERIFICATION_CONFLICT.
 */
export const mapStripeRefund = Effect.fn('StripeEvidence.mapStripeRefund')(function* mapStripeRefund(
  refund: StripeRefund,
  context: StripeObservationContext<StripeRefundExpectation>,
) {
  if (Option.isSome(refund.livemode)) {
    yield* requireLivemode(context.environment, refund.livemode.value);
  }
  const paymentIntentRefs: readonly ProviderObjectRef[] = Option.match(refund.payment_intent, {
    onNone: () => [],
    onSome: (id) => [{ _tag: 'STRIPE_PAYMENT_INTENT', id }],
  });
  const claimed = stripeOrderReferenceOf(refund.metadata);
  const orderReference = verifiedOrderReferenceOf(claimed, context.expected.operationId);
  const subject: FindingSubject = {
    expectedAmount: context.expected.amount,
    operationId: context.expected.operationId,
    operationKind: 'REFUND',
    orderReference,
    providerRefs: [{ _tag: 'STRIPE_REFUND', id: refund.id }, ...paymentIntentRefs],
  };
  if (Option.isSome(claimed) && Option.isNone(orderReference)) {
    const conflict: readonly ProviderFindingResult[] = [findingOf(subject, 'VERIFICATION_CONFLICT', Option.none())];
    return conflict;
  }
  if (Option.isNone(refund.status)) {
    const indeterminate: readonly ProviderFindingResult[] = [findingOf(subject, 'INDETERMINATE', Option.none())];
    return indeterminate;
  }
  const reported = yield* reportedOf(refund.amount, refund.currency);
  const finding = yield* Match.value(refund.status.value).pipe(
    Match.whenOr('pending', 'requires_action', () =>
      amountFinding(context, subject, {
        agreed: 'ACCEPTED_PENDING',
        factKind: 'REFUND_PENDING',
        objectId: refund.id,
        reported,
      }),
    ),
    Match.when('succeeded', () =>
      amountFinding(context, subject, {
        agreed: 'EFFECT_CONFIRMED',
        factKind: 'REFUND_CONFIRMED',
        objectId: refund.id,
        reported,
      }),
    ),
    Match.when('failed', () =>
      plainFinding(context, subject, {
        factKind: 'REFUND_NOT_EFFECTED',
        finding: 'NOT_EFFECTED',
        objectId: refund.id,
        reason: Option.some('stripe_refund_failed'),
      }),
    ),
    Match.when('canceled', () =>
      plainFinding(context, subject, {
        factKind: 'REFUND_NOT_EFFECTED',
        finding: 'NOT_EFFECTED',
        objectId: refund.id,
        reason: Option.some('stripe_refund_canceled'),
      }),
    ),
    Match.exhaustive,
  );
  const findings: readonly ProviderFindingResult[] = [finding];
  return findings;
});
