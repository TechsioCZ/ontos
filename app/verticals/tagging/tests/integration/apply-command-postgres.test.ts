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
  TaggingCommandPayloadSchema,
  TaggingReferenceUnavailable,
  TaggingRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { taggingRelations } from '../../src/database/schema.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';

const nativeTaggingCommands = Effect.scoped(
  Effect.gen(function* nativeTaggingCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: taggingRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:tagging-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'tagging-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const context: ActionServicePreparationContext = {
      actionInvocationId: resourceId,
      compositionRevision: 'tagging-command-composition',
      scope,
      transaction: () => Effect.die('Command permission checks need no SQL snapshot'),
    };
    const create = yield* Schema.decodeEffect(TaggingCommandPayloadSchema)({
      command: {
        _tag: 'CreateTag',
        color: 'blue',
        name: 'Regresní test',
        subjectKinds: ['opportunity'],
      },
      expectedRevision: 0,
    });
    const update = yield* Schema.decodeEffect(TaggingCommandPayloadSchema)({
      command: { _tag: 'UpdateTag', id: resourceId, patch: { name: 'Upravený štítek' } },
      expectedRevision: 1,
    });
    const createFactory = yield* prepareApplyCommandServices(create, context);
    const updateFactory = yield* prepareApplyCommandServices(update, context);

    const result = yield* database
      .transaction(
        Effect.fn('TaggingCommandsTest.transaction')(function* nativeTransaction(tx) {
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const creator = yield* createFactory(scoped, scope, context.compositionRevision);
          const created = yield* creator.apply(create.command, 0, resourceId);
          expect(created.revision).toBe(1);
          const updater = yield* updateFactory(scoped, scope, context.compositionRevision);
          const updated = yield* updater.apply(update.command, 1, resourceId);
          expect(updated).toMatchObject({ revision: 2, tagId: resourceId });
          const stale = yield* updater.apply(update.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(TaggingRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(TaggingReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(TaggingReferenceUnavailable)(
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

          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native tagging commands', (suite) => {
  suite.effect(
    'keeps prepared commands bound to identity, payload and revision after Core admission',
    () => nativeTaggingCommands,
  );
});
