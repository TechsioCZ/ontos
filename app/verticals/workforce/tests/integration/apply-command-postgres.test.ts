import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  WorkforceCommandPayloadSchema,
  WorkforceReferenceUnavailable,
  WorkforceRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { workforceRelations } from '../../src/database/schema.ts';
import { persistenceService, workforceSearchMetadataService } from '../../src/services/persistence.service.ts';

const nativeWorkforceCommands = Effect.scoped(
  Effect.gen(function* nativeWorkforceCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: workforceRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:workforce-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'workforce-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const context: ActionServicePreparationContext = {
      actionInvocationId: yield* crypto.randomUUIDv4(),
      compositionRevision: 'workforce-command-composition',
      scope,
      transaction: () => Effect.die('Command permission checks need no SQL snapshot'),
    };
    const create = yield* Schema.decodeEffect(WorkforceCommandPayloadSchema)({
      command: {
        _tag: 'CreateEmployee',
        active: true,
        department: 'Provoz',
        email: 'regression@example.test',
        fullName: 'Regresní test',
        id: resourceId,
        role: 'SALES_REP',
      },
      expectedRevision: 0,
    });
    const update = yield* Schema.decodeEffect(WorkforceCommandPayloadSchema)({
      command: { _tag: 'UpdateEmployee', id: resourceId, patch: { department: 'Správa' } },
      expectedRevision: 1,
    });
    const createFactory = yield* prepareApplyCommandServices(create, context);
    const updateFactory = yield* prepareApplyCommandServices(update, context);

    const result = yield* database
      .transaction(
        Effect.fn('WorkforceCommandsTest.transaction')(function* nativeTransaction(tx) {
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const creator = yield* createFactory(scoped, scope, context.compositionRevision);
          const created = yield* creator.apply(create.command, 0);
          expect(created.revision).toBe(1);
          const updater = yield* updateFactory(scoped, scope, context.compositionRevision);
          const updated = yield* updater.apply(update.command, 1);
          expect(updated).toMatchObject({ employees: [{ department: 'Správa' }], revision: 2 });
          const stale = yield* updater.apply(update.command, 1).pipe(Effect.flip);
          expect(Schema.is(WorkforceRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1).pipe(Effect.flip);
          expect(Schema.is(WorkforceReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(WorkforceReferenceUnavailable)(yield* unprepared.apply(create.command, 0).pipe(Effect.flip)),
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

          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
    // Verify native SQL rollback, not just the failed Effect: neither create nor update may
    // survive as current source evidence for a later post-commit Search refresh.
    const afterRollback = yield* database.transaction(
      Effect.fn('WorkforceCommandsTest.sourceAfterRollback')(function* sourceAfterRollback(tx) {
        const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
        const source = yield* workforceSearchMetadataService(scoped, scope);
        return yield* source.loadSearchMetadata({ groups: [] });
      }),
    );
    expect(afterRollback).toEqual([]);
  }),
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native workforce commands', (suite) => {
  suite.effect(
    'keeps prepared commands bound to identity, payload and revision after Core admission',
    () => nativeWorkforceCommands,
  );
});
