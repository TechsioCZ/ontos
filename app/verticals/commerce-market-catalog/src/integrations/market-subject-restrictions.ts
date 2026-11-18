import type { OperationalScope, ReadPrepareContext } from '@app/core-runtime';
import { requireModuleOperation } from '@app/core-runtime';
import { MarketSubjectRestrictionsCurrentRequestSchema } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import type { MarketSubjectRestrictionsCurrentResponse } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import { executeMarketSubjectRestrictionsCurrentWithAuthorization } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current/client';
import { Crypto, Effect, Option, Schema } from 'effect';

import type { PurchasingSubjectRefSchema } from '../../shared/market-contracts.ts';
import { acquireMarketOwnerDelegation } from './market-owner-delegation.ts';

type PurchasingSubject = typeof PurchasingSubjectRefSchema.Type;
type OwnerCurrentRestrictions = Extract<
  MarketSubjectRestrictionsCurrentResponse,
  { readonly outcome: 'SUBJECT_RESTRICTIONS_CURRENT' }
>;

export class MarketSubjectRestrictionsUnavailable extends Schema.TaggedError<MarketSubjectRestrictionsUnavailable>()(
  'MarketSubjectRestrictionsUnavailable',
  {
    code: Schema.Literal('market_subject_restrictions_unavailable'),
    reason: Schema.String,
  },
) {}

export interface MarketSubjectRestrictionSnapshot {
  readonly allowedChannels: readonly ('B2B' | 'B2C')[];
  readonly allowedMarketIds?: readonly string[];
  readonly allowedSellerIds: readonly string[];
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly evidenceRefs: readonly string[];
  readonly observedAt: OwnerCurrentRestrictions['observedAt'];
  readonly ownerRevision: string;
  readonly profileState: 'ACTIVE' | 'ARCHIVED' | 'SUSPENDED';
  readonly subjectIdentityRef: string;
  readonly subjectKind: 'COUNTERPARTY' | 'RETAIL_PROFILE';
}

export interface MarketSubjectRestrictionsReader {
  readonly current: (
    subject: Exclude<PurchasingSubject, { readonly kind: 'GUEST' }>,
    requestCorrelation: string,
  ) => Effect.Effect<MarketSubjectRestrictionSnapshot, MarketSubjectRestrictionsUnavailable>;
}

const unavailable = (cause: unknown): MarketSubjectRestrictionsUnavailable => {
  const failure = new MarketSubjectRestrictionsUnavailable({
    code: 'market_subject_restrictions_unavailable',
    reason: 'Current purchasing-subject Market restrictions could not be established',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const toSnapshot = (
  response: MarketSubjectRestrictionsCurrentResponse,
): Effect.Effect<MarketSubjectRestrictionSnapshot, MarketSubjectRestrictionsUnavailable> => {
  if (response.outcome !== 'SUBJECT_RESTRICTIONS_CURRENT') {
    return Effect.fail(unavailable(response));
  }
  const base = {
    allowedChannels: response.channelConstraint.allowedChannels,
    allowedSellerIds:
      response.sellerConstraint.kind === 'FIXED_SELLER'
        ? [response.sellerConstraint.sellerRef.resourceId]
        : response.sellerConstraint.sellerRefs.map(({ resourceId }) => resourceId),
    decision: response.decision,
    evidenceRefs: response.evidenceRefs,
    observedAt: response.observedAt,
    ownerRevision: response.ownerRevision,
    profileState: response.profileState,
    subjectIdentityRef: response.subject.profileRef.resourceId,
    subjectKind: response.subject.kind,
  } satisfies Omit<MarketSubjectRestrictionSnapshot, 'allowedMarketIds'>;
  return Effect.succeed(
    response.marketConstraint.kind === 'ALLOWED_MARKETS'
      ? {
          ...base,
          allowedMarketIds: response.marketConstraint.marketRefs.map(({ resourceId }) => resourceId),
        }
      : base,
  );
};

/**
 * Reads the purchasing subject's restrictions from Customer Context for the requester this scope
 * carries: the subject is the verified requester, this Market owner is the actor.
 */
export const makeServerMarketSubjectRestrictionsReader = ({
  compositionRevision,
  crypto,
  scope,
}: {
  readonly compositionRevision: string | undefined;
  readonly crypto: Crypto.Crypto;
  readonly scope: OperationalScope;
}): MarketSubjectRestrictionsReader => ({
  current: Effect.fn('MarketSubjectRestrictionsReader.current')(function* current(
    subject: Parameters<MarketSubjectRestrictionsReader['current']>[0],
    requestCorrelation: string,
  ) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the original verified Legal Entity');
    }
    if (compositionRevision === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the admitted composition revision');
    }
    if (subject.profileRef.tenantId !== scope.tenantId || requestCorrelation !== scope.correlationId) {
      return yield* unavailable('Subject restrictions require the original trusted Tenant and request correlation');
    }
    const payload = yield* Schema.decodeEffect(MarketSubjectRestrictionsCurrentRequestSchema)({ subject }).pipe(
      Effect.mapError(unavailable),
    );
    const response = yield* Effect.gen(function* executeCustomerOwnerRead() {
      const admitted = yield* acquireMarketOwnerDelegation(
        scope,
        crypto,
        'commerce-customer-context',
        compositionRevision,
      );
      return yield* executeMarketSubjectRestrictionsCurrentWithAuthorization(
        payload,
        admitted.authorization,
        requestCorrelation,
        {
          baseUrl: new URL(admitted.apiBaseUrl),
          compositionRevision: admitted.compositionRevision,
        },
      );
    }).pipe(Effect.mapError(unavailable));
    return yield* toSnapshot(response);
  }),
});

/** Production reader for a Read's `prepare` step: the verified composition and Legal Entity of that Read. */
export const serverMarketSubjectRestrictionsReaderFor = Effect.fn('MarketSubjectRestrictions.captureReader')(
  function* captureSubjectRestrictionsReader(context: ReadPrepareContext) {
    const crypto = yield* Crypto.Crypto;
    return makeServerMarketSubjectRestrictionsReader({
      compositionRevision: context.compositionRevision,
      crypto,
      scope: context.scope,
    });
  },
);

/**
 * The production reader of one Read's owner step: every question first admits the Read's declared Customer Context
 * requirement, so `prepare` and the check before release ask through the same admitted contract.
 */
export const requiredSubjectRestrictionsReader = Effect.fn('MarketSubjectRestrictions.requiredReader')(
  function* requiredSubjectRestrictionsReader(context: ReadPrepareContext, requirementKey: string) {
    const source = yield* serverMarketSubjectRestrictionsReaderFor(context);
    return {
      current: (subject, requestCorrelation) =>
        requireModuleOperation(requirementKey).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new MarketSubjectRestrictionsUnavailable({
                code: 'market_subject_restrictions_unavailable',
                reason: 'Current subject restrictions contract is unavailable',
              }),
              'cause',
              { configurable: true, value: cause },
            ),
          ),
          Effect.andThen(source.current(subject, requestCorrelation)),
        ),
    } satisfies MarketSubjectRestrictionsReader;
  },
);

/**
 * The purchasing subject's current restrictions from Customer Context, read in `prepare` so the remote round trip
 * never holds the Read's database connection. None for an absent or guest subject, and none when the owner cannot
 * answer (the caller fails closed for a named subject).
 */
export const currentSubjectRestrictions = (
  reader: MarketSubjectRestrictionsReader,
  subject: PurchasingSubject | undefined,
  requestCorrelation: string,
): Effect.Effect<Option.Option<MarketSubjectRestrictionSnapshot>> =>
  subject === undefined || subject.kind === 'GUEST'
    ? Effect.succeedNone
    : reader.current(subject, requestCorrelation).pipe(Effect.option);

const sameValues = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]));

/** Whether two owner answers restrict the subject identically; only the instant of observation may differ. */
const sameRestrictions = (used: MarketSubjectRestrictionSnapshot, current: MarketSubjectRestrictionSnapshot) =>
  used.ownerRevision === current.ownerRevision &&
  used.decision === current.decision &&
  used.profileState === current.profileState &&
  used.subjectIdentityRef === current.subjectIdentityRef &&
  used.subjectKind === current.subjectKind &&
  sameValues(used.allowedChannels, current.allowedChannels) &&
  sameValues(used.allowedSellerIds, current.allowedSellerIds) &&
  sameValues(used.allowedMarketIds, current.allowedMarketIds) &&
  sameValues(used.evidenceRefs, current.evidenceRefs);

/**
 * The check before release, run in `finish` after `load` committed: `load` filtered Markets by the restrictions
 * `prepare` read, so Customer Context is asked again and the result may leave only when it still answers exactly
 * those restrictions. A subject suspended, re-sellered or re-revisioned while the Read waited, or an owner that
 * cannot answer now, is `false`, and the Read refuses its result. Nothing was used when `prepare` read nothing (a
 * guest, or a named subject `load` already answered as unavailable), so there is nothing to confirm.
 */
export const subjectRestrictionsUnchanged = <Failure, Requirements>(
  used: Option.Option<MarketSubjectRestrictionSnapshot>,
  subject: PurchasingSubject | undefined,
  requestCorrelation: string,
  reader: Effect.Effect<MarketSubjectRestrictionsReader, Failure, Requirements>,
): Effect.Effect<boolean, Failure, Requirements> => {
  if (Option.isNone(used)) {
    return Effect.succeed(true);
  }
  if (subject === undefined || subject.kind === 'GUEST') {
    return Effect.succeed(false);
  }
  return reader.pipe(
    Effect.flatMap((source) => currentSubjectRestrictions(source, subject, requestCorrelation)),
    Effect.map((current) => Option.isSome(current) && sameRestrictions(used.value, current.value)),
  );
};
