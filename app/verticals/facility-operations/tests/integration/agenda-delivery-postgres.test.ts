import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  ContextAccess,
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, ContextAccessService, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  ApplyCommandPayloadSchema,
  FacilityOperationsReferenceUnavailable,
  FacilityOperationsRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { agendaStates, facilityOperationsRelations } from '../../src/database/schema.ts';

const nativeAgendaDelivery = Effect.scoped(
  Effect.gen(function* nativeAgendaDelivery() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: facilityOperationsRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:agenda-delivery-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'agenda-delivery-test' };
    const enrollment = defineDatabaseIdentityEnrollment([]);
    const invocationId = yield* crypto.randomUUIDv4();
    const context: ActionServicePreparationContext = {
      actionInvocationId: invocationId,
      compositionRevision: 'agenda-delivery-composition',
      scope,
      transaction: () => Effect.die('Permission preparation needs no SQL snapshot'),
    };
    let insideTransaction = false;
    let permissionChecks = 0;
    const access: ContextAccessService = {
      contextPermissions: (input) =>
        Effect.sync(() => {
          expect(insideTransaction).toBe(false);
          expect(input.principalId).toBe(scope.principalId);
          expect(input.tenantId).toBe(scope.tenantId);
          expect(input.legalEntityId).toBe(scope.legalEntityId);
          permissionChecks += 1;
          return input.targets.map(({ moduleId, permission }) => ({
            decision: 'allowed' as const,
            key: `${moduleId}:${permission}`,
          }));
        }),
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'AgendaNotificationsDeliver',
        items: [{ category: 'DEADLINE', eventKey: 'deadline:test', source: 'ops', title: 'Kontrola termínu' }],
      },
      expectedRevision: 0,
    });
    const factory = yield* prepareApplyCommandServices(payload, context).pipe(
      Effect.provideService(ContextAccess, access),
    );
    expect(permissionChecks).toBe(1);
    // Roll back the entire native fixture, including successful owner writes, after the assertions.
    const result = yield* database
      .transaction(
        Effect.fn('AgendaDeliveryTest.transaction')(function* nativeTransaction(transaction) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(transaction, scope, enrollment);
          const services = yield* factory(scoped, scope, context.compositionRevision);
          const first = yield* services.apply(payload.command, 0, invocationId);
          expect(first.entityIds).toHaveLength(1);
          expect(first.revision).toBe(1);
          const duplicate = yield* services.apply(payload.command, first.revision, invocationId);
          expect(duplicate.entityIds).toEqual([]);
          const stale = yield* services.apply(payload.command, 0, invocationId).pipe(Effect.flip);
          expect(Schema.is(FacilityOperationsRevisionConflict)(stale)).toBe(true);
          const rows = yield* transaction
            .select({ state: agendaStates.state })
            .from(agendaStates)
            .where(and(eq(agendaStates.tenantId, scope.tenantId), eq(agendaStates.agenda, 'agenda')));
          expect(rows).toHaveLength(1);
          expect(rows[0]?.state).toMatchObject({
            notifications: [{ eventKey: 'deadline:test', recipient: { principalId: scope.principalId } }],
          });
          for (const changed of [
            { ...scope, tenantId: scope.principalId },
            { ...scope, principalId: scope.tenantId },
            { ...scope, legalEntityId: scope.principalId },
            { ...scope, correlationId: 'another-invocation' },
          ]) {
            const failure = yield* factory(scoped, changed, context.compositionRevision).pipe(Effect.flip);
            expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
          }
          const revisionFailure = yield* factory(scoped, scope, 'another-composition').pipe(Effect.flip);
          expect(Schema.is(OperationContextUnavailable)(revisionFailure)).toBe(true);
          expect(permissionChecks).toBe(1);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.provideService(ContextAccess, access), Effect.flip);
    expect(result).toBe('fixture-rollback');
    insideTransaction = false;
    const unavailableAccess: ContextAccessService = {
      ...access,
      contextPermissions: ({ targets }) =>
        Effect.succeed(
          targets.map(({ moduleId, permission }) => ({
            decision: 'unavailable' as const,
            key: `${moduleId}:${permission}`,
          })),
        ),
    };
    const unavailable = yield* prepareApplyCommandServices(payload, context).pipe(
      Effect.provideService(ContextAccess, unavailableAccess),
      Effect.flip,
    );
    expect(Schema.is(FacilityOperationsReferenceUnavailable)(unavailable)).toBe(true);
  }),
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native agenda notification delivery', (suite) => {
  suite.effect(
    'prepares permission I/O before SQL, revalidates scope, reloads state and deduplicates delivery',
    () => nativeAgendaDelivery,
  );
});
