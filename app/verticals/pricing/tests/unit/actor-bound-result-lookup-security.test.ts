import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PgTypes } from '@effect/sql-pg';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { currencySupportPersistence } from '../../src/persistence/currency-support-persistence.ts';
import { commercialFeePersistenceForScope } from '../../src/services/commercial-fee-persistence.service.ts';
import { contractualDiscountPersistenceForScope } from '../../src/services/contractual-discount-persistence.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../../src/services/quantity-tier-persistence.service.ts';
import { quotationPersistenceForScope } from '../../src/services/quotation-persistence.service.ts';
import { zeroFloorAuthorizationPersistenceForScope } from '../../src/services/zero-floor-authorization-persistence.service.ts';

const tenantId = '73800000-0000-4000-8000-000000000001';
const legalEntityId = '73800000-0000-4000-8000-000000000002';
const trustedPrincipalId = '73800000-0000-4000-8000-000000000003';
const foreignPrincipalId = '73800000-0000-4000-8000-000000000004';
const actionInvocationId = '73800000-0000-4000-8000-000000000005';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '73800000-0000-4000-8000-000000000006',
    authContextRef: 'better-auth-session:pricing-result-owner',
    authMethod: 'session',
    legalEntityId,
    principalId: trustedPrincipalId,
    tenantId,
  }),
  correlationId: 'pricing-result-owner-binding',
};

type ScopedTransaction = ReturnType<typeof scopedRoutineInvokerFromTransaction>;

interface ActorBindingScenario {
  readonly family: string;
  readonly lookup: (transaction: ScopedTransaction) => Effect.Effect<unknown, Error>;
  readonly payload: Readonly<Record<string, string>>;
  readonly routineName: string;
  readonly scopeParameters: readonly unknown[];
}

const actorBoundInput = { actingPrincipalId: foreignPrincipalId, actionInvocationId };
const tenantLegalEntityScope = [tenantId, legalEntityId] as const;

const scenarios: readonly ActorBindingScenario[] = [
  {
    family: 'Price',
    lookup: (transaction) =>
      Effect.flatMap(pricePersistenceForScope(transaction, scope), (persistence) =>
        persistence.lookupResult(actorBoundInput),
      ),
    payload: { actionInvocationId, outcome: 'PRICE_ACTION_RESULT_ABSENT' },
    routineName: 'lookup_price_action_result_v1',
    scopeParameters: tenantLegalEntityScope,
  },
  {
    family: 'Currency Support',
    lookup: (transaction) =>
      currencySupportPersistence(transaction, tenantId, trustedPrincipalId).lookupResult(actorBoundInput),
    payload: {
      actingPrincipalId: trustedPrincipalId,
      actionInvocationId,
      outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN',
    },
    routineName: 'lookup_tenant_currency_support_result_v1',
    scopeParameters: [tenantId],
  },
  {
    family: 'Quantity Tier',
    lookup: (transaction) =>
      Effect.flatMap(quantityTierPersistenceForScope(transaction, scope), (persistence) =>
        persistence.lookupResult(actorBoundInput),
      ),
    payload: { actionInvocationId, outcome: 'QUANTITY_TIER_RESULT_ABSENT' },
    routineName: 'lookup_quantity_tier_action_result_v1',
    scopeParameters: tenantLegalEntityScope,
  },
  {
    family: 'Contractual Discount',
    lookup: (transaction) =>
      Effect.flatMap(contractualDiscountPersistenceForScope(transaction, scope), (persistence) =>
        persistence.lookupResult(actorBoundInput),
      ),
    payload: { actionInvocationId, outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT' },
    routineName: 'lookup_contractual_discount_result_v1',
    scopeParameters: tenantLegalEntityScope,
  },
  {
    family: 'Commercial Fee',
    lookup: (transaction) =>
      Effect.flatMap(commercialFeePersistenceForScope(transaction, scope), (persistence) =>
        persistence.lookupResult(actorBoundInput),
      ),
    payload: { actionInvocationId, outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT' },
    routineName: 'lookup_commercial_fee_action_result_v1',
    scopeParameters: tenantLegalEntityScope,
  },
  {
    family: 'ZERO_FLOOR',
    lookup: (transaction) =>
      Effect.flatMap(zeroFloorAuthorizationPersistenceForScope(transaction, scope), (persistence) =>
        persistence.lookupResult(actorBoundInput),
      ),
    payload: { actionInvocationId, outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT' },
    routineName: 'lookup_zero_floor_authorization_result_v1',
    scopeParameters: tenantLegalEntityScope,
  },
  {
    family: 'Quotation',
    lookup: (transaction) =>
      Effect.flatMap(quotationPersistenceForScope(transaction, scope), (persistence) =>
        Effect.map(persistence.lookupInvocation(actionInvocationId), (result) => {
          expect(Option.isNone(result)).toBe(true);
          return result;
        }),
      ),
    payload: { actionInvocationId, outcome: 'NOT_FOUND' },
    routineName: 'lookup_pricing_quotation_invocation_v1',
    scopeParameters: tenantLegalEntityScope,
  },
];

describe('Pricing actor-bound result lookup security', () => {
  for (const scenario of scenarios) {
    it.effect(`${scenario.family} denies a same-Tenant/same-SLE attempt to select a foreign Principal invocation`, () =>
      Effect.gen(function* provesActorBinding() {
        let statement: SQL | undefined;
        const transaction = scopedRoutineInvokerFromTransaction(
          (candidate) => {
            statement = candidate;
            return Effect.succeed([{ payload: scenario.payload }]);
          },
          { legalEntityId, tenantId },
        );

        yield* scenario.lookup(transaction);
        const invokedStatement = yield* Effect.suspend(() =>
          statement === undefined
            ? Effect.die(`${scenario.family} result lookup did not invoke its owner routine`)
            : Effect.succeed(statement),
        );
        const bound = new PgDialect().sqlToQuery(invokedStatement);
        expect(bound.sql).toContain(`"pricing"."${scenario.routineName}"`);
        const actorParameters =
          scenario.family === 'Quotation'
            ? [trustedPrincipalId, actionInvocationId]
            : [PgTypes.jsonb({ actingPrincipalId: trustedPrincipalId, actionInvocationId })];
        expect(bound.params).toEqual([...scenario.scopeParameters, ...actorParameters]);
        const encodedParameters = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(bound.params);
        expect(encodedParameters).not.toContain(foreignPrincipalId);
      }),
    );
  }
});
