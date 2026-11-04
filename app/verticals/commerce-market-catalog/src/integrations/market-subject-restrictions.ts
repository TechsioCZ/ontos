import type { OperationalScope } from '@app/core-runtime';
import { MarketSubjectRestrictionsCurrentRequestSchema } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import type { MarketSubjectRestrictionsCurrentResponse } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import { executeMarketSubjectRestrictionsCurrentWithAuthorization } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current/client';
import { Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

import type { PurchasingSubjectRefSchema } from '../../shared/market-contracts.ts';
import { acquireOwnerGatewayContext } from './server-owner-gateway.ts';

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
    if (compositionRevision === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the original verified composition revision');
    }
    if (scope.legalEntityId === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the original verified Legal Entity');
    }
    if (subject.profileRef.tenantId !== scope.tenantId || requestCorrelation !== scope.correlationId) {
      return yield* unavailable('Subject restrictions require the original trusted Tenant and request correlation');
    }
    const payload = yield* Schema.decodeEffect(MarketSubjectRestrictionsCurrentRequestSchema)({ subject }).pipe(
      Effect.mapError(unavailable),
    );
    const response = yield* Effect.gen(function* executeCustomerOwnerRead() {
      const admitted = yield* acquireOwnerGatewayContext(
        scope,
        crypto,
        {
          audience: 'commerce-customer-context',
          operationKey: 'commerce.customer-context.api.market-subject-restrictions-current',
        },
        compositionRevision,
      );
      return yield* executeMarketSubjectRestrictionsCurrentWithAuthorization(
        payload,
        Redacted.value(admitted.authorization),
        scope.correlationId,
        { baseUrl: admitted.apiUrl, compositionRevision },
      );
    }).pipe(Effect.mapError(unavailable));
    return yield* toSnapshot(response);
  }),
});
