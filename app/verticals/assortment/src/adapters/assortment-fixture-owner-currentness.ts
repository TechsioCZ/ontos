import {
  AssortmentProductClassificationV1Api,
  AssortmentProductClassificationV1RequestSchema,
} from '@app/catalog/api/assortment-product-classification-v1';
import {
  CustomerGroupDetailApi,
  CustomerGroupDetailRequestSchema,
} from '@app/commerce-customer-context/api/customer-group-detail';
import {
  AssortmentFixtureMarketAssociationApi,
  AssortmentFixtureMarketAssociationRequestSchema,
} from '@app/commerce-market-catalog/api/assortment-fixture-market-association';
import type { OperationalScope, OwnerAuthorizationDecision } from '@app/core-runtime';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import {
  CurrentStorefrontApplicationApi,
  CurrentStorefrontApplicationRequestSchema,
} from '@app/storefront-registry-contracts/current-storefront-application';
import type { Crypto } from 'effect';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import type { HttpApi, HttpApiGroup } from 'effect/http-api';
import type { HttpClient } from 'effect/http';

import { findEnrolledSymmyRuleFixture, importSymmyRuleActionKey } from '../services/symmy-rule-fixture-enrollment.ts';

const ownerReads = {
  group: {
    appId: 'commerce-customer-context',
    declarationKey: 'commerce.customer-context.customer-group.read',
    entrypointKey: 'commerce.customer-context.api.customer-group-detail',
    moduleId: 'commerce.customer-context',
    requirementKey: 'commerce.assortment.requirement.symmy-fixture-customer-group-current',
    scope: 'subject',
  },
  market: {
    appId: 'commerce-market-catalog',
    declarationKey: 'commerce.market-catalog.assortment-fixture-market-association.read',
    entrypointKey: 'commerce.market-catalog.api.assortment-fixture-market-association',
    moduleId: 'commerce.market-catalog',
    requirementKey: 'commerce.assortment.requirement.symmy-fixture-market-association-current',
    scope: 'subject',
  },
  product: {
    appId: 'catalog',
    declarationKey: 'commerce.catalog.assortment-product-classification-v1.read',
    entrypointKey: 'commerce.catalog.api.assortment-product-classification-v1',
    moduleId: 'commerce.catalog',
    requirementKey: 'commerce.assortment.requirement.symmy-fixture-product-current',
    scope: 'tenant',
  },
  storefront: {
    appId: 'storefront-registry',
    declarationKey: 'commerce.storefront-registry.storefront-application.read-current',
    entrypointKey: 'commerce.storefront-registry.api.current-storefront-application',
    moduleId: 'commerce.storefront-registry',
    requirementKey: 'commerce.assortment.requirement.symmy-fixture-storefront-current',
    scope: 'subject',
  },
} as const;

export const assortmentFixtureOwnerRequirements = Object.values(ownerReads).map((read) => ({
  condition: 'commerce.assortment.condition.enrolled-symmy-rule-fixture',
  entrypointKey: importSymmyRuleActionKey,
  evidence: [read.declarationKey],
  key: read.requirementKey,
  provider: { entrypointKey: read.entrypointKey, moduleId: read.moduleId, schemaVersion: '1' },
}));

const ownerClient = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  owner: (typeof ownerReads)[keyof typeof ownerReads],
  scope: OperationalScope,
  crypto: Crypto.Crypto,
) =>
  acquireDelegatedGatewayContext(
    {
      audience: owner.appId,
      callingAppId: 'assortment',
      legalEntityScope: owner.scope,
      requestCorrelation: scope.correlationId,
      subject: {
        _tag: 'RegisteredAssertion',
        declarationKey: owner.declarationKey,
        operationRequirementKey: owner.requirementKey,
        scope,
      },
    },
    crypto,
  ).pipe(
    Effect.tapError((failure) =>
      Effect.logWarning('Assortment fixture owner delegation failed', {
        owner: owner.moduleId,
        reason: Schema.is(GatewayDelegationSourceError)(failure) ? failure.reason : failure._tag,
      }),
    ),
    Effect.flatMap((issued) =>
      makeGovernedEffectBffClient(
        {
          api,
          credential: Redacted.make(issued.authorization),
          defaultApiPrefix: `/${owner.appId}-api`,
          requestCorrelation: scope.correlationId,
        },
        { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
      ),
    ),
  );

export const checkAssortmentFixtureOwnerCurrentness = (
  crypto: Crypto.Crypto,
  scope: OperationalScope,
  at: DateTime.Utc,
  commandFingerprint: string,
): Effect.Effect<OwnerAuthorizationDecision, never, HttpClient.HttpClient> =>
  Effect.gen(function* fixtureCurrentness() {
    const { command } = yield* findEnrolledSymmyRuleFixture(scope, commandFingerprint);
    const { channelRef, commerceMarketRef, sellingLegalEntityRef, storefrontRef } = command.binding.commercialScope;
    if (
      commerceMarketRef.resourceType !== 'commerce.market-catalog.market' ||
      sellingLegalEntityRef.resourceType !== 'core.identity.legal-entity' ||
      storefrontRef.resourceType !== 'commerce.storefront-registry.storefront-application' ||
      command.binding.storefrontAppId === undefined
    ) {
      // Legacy fixture request bytes remain decodable for exact historical receipt lookup.
      return 'unavailable' as const;
    }
    const effectiveAt = DateTime.formatIso(at);
    const marketRequest = yield* Schema.decodeUnknownEffect(AssortmentFixtureMarketAssociationRequestSchema)({
      channel: channelRef.resourceId,
      effectiveAt,
      marketRef: commerceMarketRef,
      storefrontRef: { appId: command.binding.storefrontAppId, tenantId: storefrontRef.tenantId },
    });
    const productRequest = yield* Schema.decodeUnknownEffect(AssortmentProductClassificationV1RequestSchema)({
      request: { effectiveAt, operation: 'OBSERVE', productRef: command.rule.selector.productRef },
    });
    const groupRequest = yield* Schema.decodeUnknownEffect(CustomerGroupDetailRequestSchema)({
      groupRef: command.binding.audience.groupRef,
    });
    const storefrontRequest = yield* Schema.decodeUnknownEffect(CurrentStorefrontApplicationRequestSchema)({
      effectiveAt,
      expectedStorefrontApplicationId: storefrontRef.resourceId,
      requestedChannel: marketRequest.channel,
      storefrontAppId: command.binding.storefrontAppId,
      tenantId: storefrontRef.tenantId,
    });
    const product = yield* ownerClient(AssortmentProductClassificationV1Api, ownerReads.product, scope, crypto);
    const classification = yield* product.assortmentProductClassificationV1.execute({ payload: productRequest });
    if (
      classification.operation !== 'OBSERVE' ||
      classification.observation.productRef.resourceId !== command.rule.selector.productRef.resourceId ||
      classification.observation.productRef.tenantId !== scope.tenantId ||
      DateTime.formatIso(classification.observation.effectiveAt) !== effectiveAt
    ) {
      return 'unavailable' as const;
    }
    const commerce = yield* ownerClient(CustomerGroupDetailApi, ownerReads.group, scope, crypto);
    const { group } = yield* commerce.customerGroupDetail.execute({ payload: groupRequest });
    if (
      group.groupRef.resourceId !== groupRequest.groupRef.resourceId ||
      group.groupRef.tenantId !== scope.tenantId ||
      group.currentState !== 'ACTIVE' ||
      !group.lifecycleHistory.some(({ activeFrom, archivedAt }) => activeFrom <= effectiveAt && archivedAt === null)
    ) {
      return 'unavailable' as const;
    }
    const market = yield* ownerClient(AssortmentFixtureMarketAssociationApi, ownerReads.market, scope, crypto);
    const association = yield* market.assortmentFixtureMarketAssociation.execute({ payload: marketRequest });
    if (association.state !== 'CURRENT') {
      return 'unavailable' as const;
    }
    const storefront = yield* ownerClient(CurrentStorefrontApplicationApi, ownerReads.storefront, scope, crypto);
    const current = yield* storefront.currentStorefrontApplication.execute({ payload: storefrontRequest });
    return current.outcome === 'CURRENT' &&
      current.tenantId === scope.tenantId &&
      current.effectiveAt === effectiveAt &&
      current.requestedChannel === marketRequest.channel &&
      current.storefrontAppId === storefrontRequest.storefrontAppId
      ? ('allowed' as const)
      : ('unavailable' as const);
  }).pipe(
    Effect.catchTag('AssortmentSymmyFixtureAccessDenied', () => Effect.succeed('denied' as const)),
    Effect.tapError((failure) =>
      Effect.logWarning('Assortment fixture Current evidence was unavailable', {
        failure: failure._tag,
      }),
    ),
    Effect.orElseSucceed(() => 'unavailable' as const),
  );
