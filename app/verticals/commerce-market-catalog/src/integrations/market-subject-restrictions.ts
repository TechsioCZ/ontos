import { MarketSubjectRestrictionsCurrentRequestSchema } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import type { MarketSubjectRestrictionsCurrentResponse } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import { executeMarketSubjectRestrictionsCurrentWithAuthorization } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current/client';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Schema } from 'effect';

import type { PurchasingSubjectRefSchema } from '../../shared/market-contracts.ts';

type PurchasingSubject = typeof PurchasingSubjectRefSchema.Type;
type OwnerCurrentRestrictions = Extract<
  MarketSubjectRestrictionsCurrentResponse,
  { readonly outcome: 'SUBJECT_RESTRICTIONS_CURRENT' }
>;

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Service URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);
const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

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
  legalEntityId,
}: {
  readonly compositionRevision: string | undefined;
  readonly legalEntityId: string | undefined;
}): MarketSubjectRestrictionsReader => ({
  current: Effect.fn('MarketSubjectRestrictionsReader.current')(function* current(
    subject: Parameters<MarketSubjectRestrictionsReader['current']>[0],
    requestCorrelation: string,
  ) {
    if (compositionRevision === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the original verified composition revision');
    }
    if (legalEntityId === undefined) {
      return yield* unavailable('Cross-owner subject restrictions require the original verified Legal Entity');
    }
    const payload = yield* Schema.decodeEffect(MarketSubjectRestrictionsCurrentRequestSchema)({ subject }).pipe(
      Effect.mapError(unavailable),
    );
    const response = yield* Effect.gen(function* executeCustomerOwnerRead() {
      const configured = yield* configuration;
      const issued = yield* issueApiKeyGatewayContext(
        { audience: 'commerce-customer-context', compositionRevision, legalEntityId },
        { apiKey: configured.apiKey, baseUrl: configured.shellBaseUrl, requestCorrelation },
      );
      const admitted = yield* Schema.decodeEffect(GatewayContextResponseSchema)(issued);
      if (admitted.compositionRevision !== compositionRevision) {
        return yield* unavailable('Customer Context gateway returned a different composition revision');
      }
      return yield* executeMarketSubjectRestrictionsCurrentWithAuthorization(
        payload,
        `Bearer ${admitted.token}`,
        requestCorrelation,
        {
          baseUrl: new URL(admitted.apiBaseUrl, configured.shellBaseUrl),
          compositionRevision,
        },
      );
    }).pipe(Effect.mapError(unavailable));
    return yield* toSnapshot(response);
  }),
});
