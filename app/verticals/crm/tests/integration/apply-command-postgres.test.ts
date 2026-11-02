import {
  ActiveApplicationCompositionService,
  ContextAccess,
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { Layer, Crypto, Effect, Redacted, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import type { ActionServicePreparationContext, ContextAccessService, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';

import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  CrmReferenceUnavailable,
  CrmRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { crmRelations } from '../../src/database/schema.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';

const unusedReference = () => Effect.die('Unexpected reference boundary access');
const referenceBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unusedReference() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unusedReference() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
);

const nativeCrmCommands = Effect.scoped(
  Effect.gen(function* nativeCrmCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: crmRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:crm-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'crm-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const context: ActionServicePreparationContext = {
      actionInvocationId: resourceId,
      compositionRevision: 'crm-command-composition',
      scope,
      transaction: () => Effect.die('Command permission checks need no SQL snapshot'),
    };
    let insideTransaction = false;
    let permissionChecks = 0;
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
      command: {
        _tag: 'CreateClient',
        kind: 'organization',
        name: 'Regresní test',
      },
      expectedRevision: 0,
    });
    const update = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: { _tag: 'UpdateClient', id: `${resourceId}-client`, patch: { name: 'Upravený klient' } },
      expectedRevision: 1,
    });
    const createFactory = yield* prepareApplyCommandServices(create, context).pipe(
      Effect.provideService(ContextAccess, access),
    );
    const updateFactory = yield* prepareApplyCommandServices(update, context).pipe(
      Effect.provideService(ContextAccess, access),
    );
    expect(permissionChecks).toBe(2);
    const result = yield* database
      .transaction(
        Effect.fn('CrmCommandsTest.transaction')(function* nativeTransaction(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const creator = yield* createFactory(scoped, scope, context.compositionRevision);
          const created = yield* creator.apply(create.command, 0, resourceId);
          expect(created.revision).toBe(1);
          const updater = yield* updateFactory(scoped, scope, context.compositionRevision);
          const updated = yield* updater.apply(update.command, 1, resourceId);
          expect(updated).toMatchObject({ entityIds: [`${resourceId}-client`], revision: 2 });
          const stale = yield* updater.apply(update.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(CrmRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(CrmReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(CrmReferenceUnavailable)(
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
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
);

it.layer(Layer.merge(NodeCrypto.layer, referenceBoundary), { excludeTestServices: true })(
  'native crm commands',
  (suite) => {
    suite.effect(
      'prepares permissions outside SQL; revalidates identity, payload and revision',
      () => nativeCrmCommands,
    );
  },
);
