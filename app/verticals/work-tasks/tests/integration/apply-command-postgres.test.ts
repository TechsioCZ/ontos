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
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  WorkReferenceUnavailable,
  WorkRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { workRelations } from '../../src/database/schema.ts';
import { referenceTransportNotUsed } from '../support/reference-transport.ts';
import { WorkReferenceVerifier, persistenceService } from '../../src/services/persistence.service.ts';

const nativeWorkCommands = Effect.scoped(
  Effect.gen(function* nativeWorkCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: workRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:work-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'work-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const taskRef = yield* Schema.decodeEffect(TaskRefSchema)({
      moduleId: 'work.tasks',
      resourceId,
      resourceType: 'work.tasks.task',
      tenantId: scope.tenantId,
    });
    const context: ActionServicePreparationContext = {
      actionInvocationId: yield* crypto.randomUUIDv4(),
      compositionRevision: 'work-command-composition',
      scope,
      transaction: () => Effect.die('Command permission checks need no SQL snapshot'),
    };
    let insideTransaction = false;
    let permissionChecks = 0;
    let referenceChecks = 0;
    const access: ContextAccessService = {
      contextPermissions: ({ targets }) =>
        Effect.sync(() => {
          expect(insideTransaction).toBe(false);
          permissionChecks += 1;
          return targets.map(({ moduleId, permission }) => ({
            decision: 'allowed' as const,
            key: `${moduleId}:${permission}`,
          }));
        }),
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.die('Company writer needs no per-task check'),
      tenants: () => Effect.succeed([]),
    };
    const create = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: { _tag: 'CreateTask', title: 'Kontrola provozu' },
      expectedRevision: 0,
    });
    const update = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'UpdateTask',
        contextRefs: [
          {
            moduleId: 'property.portfolio',
            resourceId: yield* crypto.randomUUIDv4(),
            resourceType: 'property.portfolio.property',
            tenantId: scope.tenantId,
          },
        ],
        taskRef,
        title: 'Kontrola dokončena',
      },
      expectedRevision: 1,
    });
    const createFactory = yield* prepareApplyCommandServices(create, context).pipe(
      Effect.provideService(ContextAccess, access),
    );
    const updateFactory = yield* prepareApplyCommandServices(update, context).pipe(
      Effect.provideService(ContextAccess, access),
      Effect.provideService(WorkReferenceVerifier, {
        verify: () =>
          Effect.sync(() => {
            expect(insideTransaction).toBe(false);
            referenceChecks += 1;
          }),
      }),
    );
    expect(permissionChecks).toBe(2);
    expect(referenceChecks).toBe(1);
    const result = yield* database
      .transaction(
        Effect.fn('WorkCommandsTest.transaction')(function* nativeTransaction(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const creator = yield* createFactory(scoped, scope, context.compositionRevision);
          const created = yield* creator.apply(create.command, 0, resourceId);
          expect(created.revision).toBe(1);
          const updater = yield* updateFactory(scoped, scope, context.compositionRevision);
          const updated = yield* updater.apply(update.command, 1, resourceId);
          expect(updated).toMatchObject({ revision: 2, task: { title: 'Kontrola dokončena' } });
          const stale = yield* updater.apply(update.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(WorkRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(WorkReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(WorkReferenceUnavailable)(
              yield* unprepared.apply(create.command, 0, resourceId).pipe(Effect.flip),
            ),
          ).toBe(true);
          for (const other of [
            { ...scope, principalId: scope.tenantId },
            { ...scope, tenantId: scope.principalId },
            { ...scope, legalEntityId: scope.principalId },
            { ...scope, correlationId: 'another-invocation' },
          ]) {
            expect(
              Schema.is(OperationContextUnavailable)(
                yield* updateFactory(scoped, other, context.compositionRevision).pipe(Effect.flip),
              ),
            ).toBe(true);
          }
          expect(
            Schema.is(OperationContextUnavailable)(
              yield* updateFactory(scoped, scope, 'another-composition').pipe(Effect.flip),
            ),
          ).toBe(true);
          expect(permissionChecks).toBe(2);
          expect(referenceChecks).toBe(1);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
).pipe(Effect.provide(referenceTransportNotUsed));

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native task commands', (suite) => {
  suite.effect(
    'prepares permissions and remote references outside SQL; revalidates identity, payload and revision',
    () => nativeWorkCommands,
  );
});
