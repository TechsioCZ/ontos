import { executeCurrentMarketCatalogWithAuthorization } from '@app/commerce-market-catalog/api/client';
import type {
  CurrentMarketCatalogRequest,
  CurrentMarketCatalogResponse,
} from '@app/commerce-market-catalog/api/client';
import type { PriceCommercialScope } from '@app/pricing-contracts/domain/price-definition';
import { Context, DateTime, Effect, Option, Redacted, Schema } from 'effect';

import {
  CommercialContextGatewayCredentialService,
  PricingCommercialContextUnavailable,
  unavailableCommercialContextGatewayCredentialIssuer,
} from '../../shared/domain/commercial-context-gateway-credential.ts';
import type { CommercialContextGatewayCredentialIssuer } from '../../shared/domain/commercial-context-gateway-credential.ts';

type CurrentMarketCatalogExecutor = (
  payload: CurrentMarketCatalogRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<CurrentMarketCatalogResponse, PricingCommercialContextUnavailable>;

export interface CommercialContextAssessmentRequest {
  readonly assessedAt: DateTime.Utc;
  readonly commercialScope: PriceCommercialScope;
  readonly tenantId: string;
}

export type CommercialContextAssessment =
  | {
      readonly commercialScope: PriceCommercialScope;
      readonly completenessEvidence: CurrentMarketCatalogResponse['completenessEvidence'];
      readonly marketDefinitionRevisionRef: CurrentMarketCatalogResponse['markets'][number]['definitionRevisionRef'];
      readonly observedAt: CurrentMarketCatalogResponse['observedAt'];
      readonly status: 'VALID';
    }
  | {
      readonly reason: string;
      readonly status: 'INVALID';
    };

export interface CommercialContextAssessmentPort {
  readonly assess: (
    request: CommercialContextAssessmentRequest,
  ) => Effect.Effect<CommercialContextAssessment, PricingCommercialContextUnavailable>;
}

class CommercialContextAssessmentService extends Context.Service<
  CommercialContextAssessmentService,
  CommercialContextAssessmentPort
>()('@app/pricing/integrations/commercial-context-evidence/CommercialContextAssessmentService') {}

const unavailable = (reason: string, cause?: unknown): PricingCommercialContextUnavailable => {
  const failure = new PricingCommercialContextUnavailable({
    code: 'pricing_commercial_context_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const executeCurrentMarketCatalog: CurrentMarketCatalogExecutor = (payload, credential, requestCorrelation, options) =>
  executeCurrentMarketCatalogWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options).pipe(
    Effect.mapError((cause) => unavailable('Commerce Market commercial-context assessment is unavailable', cause)),
  );

const containsInstant = (
  period: CurrentMarketCatalogResponse['markets'][number]['effectivePeriod'],
  instant: DateTime.Utc,
): boolean => {
  const epochMillis = DateTime.toEpochMillis(instant);
  return (
    DateTime.toEpochMillis(period.startsAt) <= epochMillis &&
    (period.endsAt === undefined || epochMillis < DateTime.toEpochMillis(period.endsAt))
  );
};

const marketMatchesRequest = (
  market: CurrentMarketCatalogResponse['markets'][number],
  request: CommercialContextAssessmentRequest,
): boolean =>
  market.lifecycle === 'ACTIVE' &&
  market.marketRef.tenantId === request.tenantId &&
  market.marketRef.resourceId === request.commercialScope.marketId &&
  market.sellingLegalEntityRef.tenantId === request.tenantId &&
  market.sellingLegalEntityRef.resourceId === request.commercialScope.sellingLegalEntityId &&
  market.channels.some((channel) => channel === request.commercialScope.channelId) &&
  containsInstant(market.effectivePeriod, request.assessedAt);

const assessCurrentMarketResponse = (
  response: CurrentMarketCatalogResponse,
  request: CommercialContextAssessmentRequest,
): Effect.Effect<CommercialContextAssessment, PricingCommercialContextUnavailable> => {
  if (
    DateTime.toEpochMillis(response.completenessEvidence.observedAt) !== DateTime.toEpochMillis(response.observedAt)
  ) {
    return Effect.fail(unavailable('Commerce Market returned completeness evidence for a different observation'));
  }
  const exactMarkets = response.markets.filter((market) => marketMatchesRequest(market, request));
  if (exactMarkets.length > 1) {
    return Effect.fail(unavailable('Commerce Market returned competing definitions for the exact context'));
  }
  const [market] = exactMarkets;
  if (market === undefined) {
    return Effect.succeed({
      reason: 'Commerce Market did not validate the exact Selling Legal Entity, Channel, and Market tuple',
      status: 'INVALID' as const,
    });
  }
  return Effect.succeed({
    commercialScope: request.commercialScope,
    completenessEvidence: response.completenessEvidence,
    marketDefinitionRevisionRef: market.definitionRevisionRef,
    observedAt: response.observedAt,
    status: 'VALID' as const,
  });
};

const makeCommercialContextAssessmentPort = (dependencies: {
  readonly context: { readonly legalEntityId: string; readonly requestCorrelation: string };
  readonly execute: CurrentMarketCatalogExecutor;
  readonly issuer: CommercialContextGatewayCredentialIssuer;
}): CommercialContextAssessmentPort =>
  CommercialContextAssessmentService.of({
    assess: (request) => {
      if (request.commercialScope.sellingLegalEntityId !== dependencies.context.legalEntityId) {
        return Effect.succeed({
          reason: 'Commercial context Selling Legal Entity does not match the trusted operation scope',
          status: 'INVALID' as const,
        });
      }
      return dependencies.issuer
        .issue({
          audience: 'commerce-market-catalog',
          legalEntityId: dependencies.context.legalEntityId,
          requestCorrelation: dependencies.context.requestCorrelation,
        })
        .pipe(
          Effect.flatMap(({ baseUrl, credential }) =>
            dependencies.execute({ at: request.assessedAt }, credential, dependencies.context.requestCorrelation, {
              baseUrl,
            }),
          ),
          Effect.mapError((cause) =>
            Schema.is(PricingCommercialContextUnavailable)(cause)
              ? cause
              : unavailable('Commerce Market commercial-context assessment is unavailable', cause),
          ),
          Effect.flatMap((response) => assessCurrentMarketResponse(response, request)),
        );
    },
  });

export const commercialContextAssessmentPortFromEnvironment = (
  context: { readonly legalEntityId: string; readonly requestCorrelation: string },
  execute: CurrentMarketCatalogExecutor = executeCurrentMarketCatalog,
): Effect.Effect<CommercialContextAssessmentPort> =>
  Effect.serviceOption(CommercialContextGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makeCommercialContextAssessmentPort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCommercialContextGatewayCredentialIssuer,
      }),
    ),
  );
