import { NodeCrypto } from '@effect/platform-node';
import { ReadRuntime, TrustedPrincipalContextSchema, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { ChangeProductManufacturerPayloadSchema } from '../../shared/actions/manufacturer-mutations.ts';
import { DateTime, Effect, Layer, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { ManufacturerTargetSchema } from '../../shared/domain/manufacturer-relation.ts';
import { ManufacturerMutationOutcomeSchema } from '../../src/persistence/manufacturer-persistence.ts';
import {
  ManufacturerTargetForbidden,
  ManufacturerTargetUnavailable,
} from '../../src/persistence/manufacturer-target-resolver.ts';
import { preparedManufacturerTargetResolver } from '../../src/services/manufacturer-target-preflight.ts';
import {
  prepareSetProductManufacturerServices,
  setProductManufacturerAction,
} from '../../src/actions/set-product-manufacturer.action.ts';
import {
  changeProductManufacturerAction,
  prepareChangeProductManufacturerServices,
} from '../../src/actions/change-product-manufacturer.action.ts';

const [, NotFoundOutcome] = ManufacturerMutationOutcomeSchema.members;
const tenantId = '11111111-1111-4111-8111-111111111111';
const target = Schema.decodeUnknownSync(ManufacturerTargetSchema)({
  kind: 'LEGAL_ENTITY',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
});
const scope = {
  authMethod: 'system' as const,
  correlationId: 'manufacturer-preflight',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};
const requestScope = { requestId: scope.correlationId, tenantId };

describe('Manufacturer target preflight evidence', () => {
  it.effect('preserves owner denial for the exact request and rejects cross-scope reuse and expiry', () =>
    Effect.gen(function* denialAndBinding() {
      const denied = new ManufacturerTargetForbidden();
      const resolver = preparedManufacturerTargetResolver({
        preparedAt: yield* DateTime.now,
        resolution: Result.fail(denied),
        scope,
        target,
      });
      expect(yield* resolver.resolve(target, requestScope).pipe(Effect.flip)).toBe(denied);
      expect(
        yield* resolver.resolve(target, { ...requestScope, requestId: 'other-invocation' }).pipe(Effect.flip),
      ).toBeInstanceOf(ManufacturerTargetUnavailable);
      expect(
        yield* resolver
          .resolve(target, { ...requestScope, tenantId: '44444444-4444-4444-8444-444444444444' })
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManufacturerTargetUnavailable);
      const anotherTarget = Schema.decodeUnknownSync(ManufacturerTargetSchema)({
        kind: 'LEGAL_ENTITY',
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      expect(yield* resolver.resolve(anotherTarget, requestScope).pipe(Effect.flip)).toBeInstanceOf(
        ManufacturerTargetUnavailable,
      );
      yield* TestClock.adjust('30 seconds');
      expect(yield* resolver.resolve(target, requestScope).pipe(Effect.flip)).toBeInstanceOf(
        ManufacturerTargetUnavailable,
      );
    }),
  );

  it('registers preflight on both manufacturer owner-resolution Actions', () => {
    expect(getActionServicePreflight(setProductManufacturerAction)).toBe(prepareSetProductManufacturerServices);
    expect(getActionServicePreflight(changeProductManufacturerAction)).toBe(prepareChangeProductManufacturerServices);
  });
});

it.effect(
  'both registered manufacturer preflights resolve before SQL, bind scope and revision, and never reread from their SQL factories',
  () =>
    Effect.gen(function* preparedFactories() {
      const operationScope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authBindingId: '88888888-8888-4888-8888-888888888888',
          authContextRef: 'better-auth-session:manufacturer-preflight',
          authMethod: 'session',
          principalId: scope.principalId,
          tenantId,
        }),
        correlationId: scope.correlationId,
      };
      const payload = Schema.decodeUnknownSync(ChangeProductManufacturerPayloadSchema)({
        effectivePeriod: {},
        evidenceRefs: ['manufacturer:owner-proof'],
        expectedRevision: 1,
        reason: 'Use the Current manufacturer owner identity',
        relationId: '66666666-6666-4666-8666-666666666666',
        subject: {
          moduleId: 'commerce.catalog',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        target,
      });
      let ownerReads = 0;
      let ownerQueries = 0;
      const runtime = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () =>
          Effect.sync(() => {
            ownerReads += 1;
            return [{ legalName: 'Current manufacturer', status: 'active', welcome: null }];
          }),
        operationTime: new Date('2026-11-07T00:00:00.000Z'),
        ownerAuthorizationDecision: 'allowed',
        scope: operationScope,
      });
      const outsideWriteReadRuntime: ReadRuntimeService = {
        runRead: (input) =>
          refuseInsideDatabaseTransaction('outbound-fetch', 'https://manufacturer-owner.example.test').pipe(
            Effect.andThen(runtime.runtime.runRead(input)),
          ),
      };
      const connection = testSqlConnection((sql) => {
        if (sql.includes('set_config')) {
          return Effect.succeed([]);
        }
        if (sql.includes('current_user')) {
          return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        if (/^(?:begin|commit|rollback|savepoint|release)/iu.test(sql.trim())) {
          return Effect.succeed([]);
        }
        if (sql.includes('from "catalog"."products"')) {
          ownerQueries += 1;
          return Effect.succeed([]);
        }
        return Effect.die(`Unexpected manufacturer factory SQL: ${sql}`);
      });
      const database = yield* makeWithDefaults({ relations: coreRelations }).pipe(
        Effect.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
      );
      const preparationContext = {
        actionInvocationId: '99999999-9999-4999-8999-999999999999',
        compositionRevision: 'a'.repeat(64),
        scope: operationScope,
        transaction: () => Effect.die('Manufacturer owner resolution must happen before owner SQL'),
      };
      for (const { kind, prepare } of [
        { kind: 'set', prepare: prepareSetProductManufacturerServices },
        { kind: 'change', prepare: prepareChangeProductManufacturerServices },
      ] as const) {
        const factory = yield* prepare(payload, preparationContext).pipe(
          Effect.provideService(ReadRuntime, outsideWriteReadRuntime),
        );
        expect(ownerReads).toBeGreaterThan(0);
        const readsBeforeSql = ownerReads;
        yield* database.transaction((transaction) =>
          Effect.gen(function* commitScope() {
            const scoped = yield* installOperationalScope(
              transaction,
              operationScope,
              defineDatabaseIdentityEnrollment([]),
            );
            for (const [candidate, revision] of [
              [
                { ...operationScope, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
                preparationContext.compositionRevision,
              ],
              [
                { ...operationScope, principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
                preparationContext.compositionRevision,
              ],
              [{ ...operationScope, correlationId: 'another-request' }, preparationContext.compositionRevision],
              [
                { ...operationScope, legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
                preparationContext.compositionRevision,
              ],
              [operationScope, 'b'.repeat(64)],
            ] as const) {
              const failure = yield* factory(scoped, candidate, revision).pipe(Effect.flip);
              expect(failure.code).toBe('operation_context_unavailable');
            }
            const services = yield* factory(scoped, operationScope, preparationContext.compositionRevision);
            const input = {
              actionInvocationId: preparationContext.actionInvocationId,
              payload,
              principalId: operationScope.principalId,
            };
            const result = yield* kind === 'set' ? services.set(input) : services.change(input);
            expect(result).toEqual(NotFoundOutcome.make({}));
          }).pipe(
            insideDatabaseTransaction('commerce.catalog.manufacturer-preflight-test'),
            Effect.provideService(ReadRuntime, {
              runRead: () => Effect.die('A prepared factory must not perform another owner read in SQL'),
            }),
          ),
        );
        expect(ownerReads).toBe(readsBeforeSql);
      }
      expect(ownerReads).toBe(2);
      expect(ownerQueries).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
