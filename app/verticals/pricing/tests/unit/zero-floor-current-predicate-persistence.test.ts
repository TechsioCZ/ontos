import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  zeroFloorAuthorizationPersistenceForScope,
  ZeroFloorAuthorizationPersistenceUnavailable,
} from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { authorizationSetFor, firstRawLine, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';

const fixture = Effect.gen(function* currentFloorFixture() {
  const scenario = yield* makeIssue779Scenario();
  const composition = yield* composePricingRawLines(scenario.compositionRequest);
  if (composition.outcome !== 'RAW_COMPOSITION_READY') {
    return yield* Effect.die('Expected raw composition');
  }
  const authorizationSet = authorizationSetFor(firstRawLine(composition.lines));
  const { query } = authorizationSet;
  const scope: OperationalScope = {
    ...(yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: '33333333-3333-4333-8333-333333333333',
      authContextRef: 'better-auth-session:zero-floor-native-predicate',
      authMethod: 'session',
      legalEntityId: query.commercialScope.sellingLegalEntityId,
      principalId: '44444444-4444-4444-8444-444444444444',
      tenantId: query.tenantId,
    })),
    correlationId: 'zero-floor-native-predicate',
  };
  const payload = {
    authority: {
      generation: 1,
      observedAt: query.effectiveAt,
      ownerRevision: authorizationSet.ownerRevision,
      ownerRootRef: 'floor-root',
      predicateRef: query.exactPredicateRef,
      verificationRef: 'floor-proof',
    },
    authorizationSet,
    factProofs: [],
    outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
  };
  return { payload, query, scope };
});

describe('ZERO_FLOOR native predicate bootstrap #1277', () => {
  it.effect('uses native bootstrap only when the caller has not supplied a fingerprint', () =>
    Effect.gen(function* routeAbsentPredicate() {
      const { payload, query, scope } = yield* fixture;
      const calls: string[] = [];
      const transaction = scopedRoutineInvokerFromTransaction(
        (statement) => {
          calls.push(new PgDialect().sqlToQuery(statement).sql);
          return Effect.succeed([{ payload }]);
        },
        { legalEntityId: query.commercialScope.sellingLegalEntityId, tenantId: scope.tenantId },
      );
      const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
      const { exactPredicateRef: _suppliedRef, ...withoutRef } = query;
      expect(yield* persistence.readCurrentSet({ query: withoutRef })).toEqual(payload);
      expect(yield* persistence.readCurrentSet({ query })).toEqual(payload);
      expect(calls[0]).toContain('read_current_zero_floor_authorization_set_for_query_v1');
      expect(calls[1]).toContain('read_current_zero_floor_authorization_set_v1');
    }),
  );

  it.effect('keeps an explicit wrong or empty reference on the original strict route', () =>
    Effect.gen(function* preserveSuppliedPredicate() {
      const { query, scope } = yield* fixture;
      const calls: { readonly params: unknown[]; readonly sql: string }[] = [];
      const transaction = scopedRoutineInvokerFromTransaction(
        (statement) => {
          calls.push(new PgDialect().sqlToQuery(statement));
          return Effect.succeed([]);
        },
        { legalEntityId: query.commercialScope.sellingLegalEntityId, tenantId: scope.tenantId },
      );
      const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
      for (const ref of ['pricing-zero-floor:incorrect:occurrence', '']) {
        expect(
          yield* Effect.flip(persistence.readCurrentSet({ query: { ...query, exactPredicateRef: ref } })),
        ).toBeInstanceOf(ZeroFloorAuthorizationPersistenceUnavailable);
      }
      expect(calls.every((call) => call.sql.includes('read_current_zero_floor_authorization_set_v1'))).toBe(true);
      expect(calls[0]?.params[2]).toMatchObject({
        value: { query: { ...query, exactPredicateRef: 'pricing-zero-floor:incorrect:occurrence' } },
      });
    }),
  );

  it.effect('does not invent authority for missing, ambiguous or malformed native output', () =>
    Effect.gen(function* rejectMalformedAuthority() {
      const { payload, query, scope } = yield* fixture;
      for (const rows of [[], [{ payload }, { payload }], [{ payload: { ...payload, authority: {} } }]]) {
        const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed(rows), {
          legalEntityId: query.commercialScope.sellingLegalEntityId,
          tenantId: scope.tenantId,
        });
        const persistence = yield* zeroFloorAuthorizationPersistenceForScope(transaction, scope);
        const { exactPredicateRef: _suppliedRef, ...withoutRef } = query;
        expect(yield* Effect.flip(persistence.readCurrentSet({ query: withoutRef }))).toBeInstanceOf(
          ZeroFloorAuthorizationPersistenceUnavailable,
        );
      }
    }),
  );
});
