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
  ActivityReferenceUnavailable,
  ActivityReferenceIneligible,
} from '../../shared/actions/apply-command.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { relationshipsRelations } from '../../src/database/schema.ts';
import { persistenceService, ActivityReferenceVerifier } from '../../src/services/persistence.service.ts';

const unusedReference = () => Effect.die('Unexpected reference boundary access');
const referenceBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unusedReference() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unusedReference() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
);

const nativeActivityCommands = Effect.scoped(
  Effect.gen(function* nativeActivityCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: relationshipsRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:activity-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'activity-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const context: ActionServicePreparationContext = {
      actionInvocationId: resourceId,
      compositionRevision: 'activity-command-composition',
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
    const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'RecordActivity',
        kind: 'CALL',
        occurredAt: '2026-11-02T00:00:00Z',
        ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId },
        partyRef: {
          moduleId: 'party.registry',
          resourceId,
          resourceType: 'party.registry.party',
          tenantId: scope.tenantId,
        },
        summary: 'Regresní test',
      },
      expectedRevision: 0,
    });
    let referenceChecks = 0;
    const factory = yield* prepareApplyCommandServices(payload, context).pipe(
      Effect.provideService(ContextAccess, access),
      Effect.provideService(ActivityReferenceVerifier, {
        verify: (command) =>
          Effect.sync(() => {
            expect(insideTransaction).toBe(false);
            referenceChecks += 1;
            if (command.partyRef === undefined) {
              throw new Error('Expected fixture party reference');
            }
            return { partyRef: command.partyRef };
          }),
      }),
    );
    expect(permissionChecks).toBe(1);
    expect(referenceChecks).toBe(1);
    const result = yield* database
      .transaction(
        Effect.fn('ActivityCommandsTest.transaction')(function* nativeTransaction(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const service = yield* factory(scoped, scope, context.compositionRevision);
          // The fixture Principal is deliberately absent from Core: the final SQL transaction must still refuse it.
          const ineligible = yield* service.apply(payload.command, 0, resourceId).pipe(Effect.flip);
          expect(Schema.is(ActivityReferenceIneligible)(ineligible)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(ActivityReferenceUnavailable)(
              yield* unprepared.apply(payload.command, 0, resourceId).pipe(Effect.flip),
            ),
          ).toBe(true);
          const changed = yield* service
            .apply({ ...payload.command, summary: 'Another command' }, 0, resourceId)
            .pipe(Effect.flip);
          expect(Schema.is(ActivityReferenceUnavailable)(changed)).toBe(true);
          expect(
            Schema.is(OperationContextUnavailable)(
              yield* factory(
                scoped,
                { ...scope, correlationId: 'another-operation' },
                context.compositionRevision,
              ).pipe(Effect.flip),
            ),
          ).toBe(true);
          expect(permissionChecks).toBe(1);
          expect(referenceChecks).toBe(1);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
);
it.layer(Layer.merge(NodeCrypto.layer, referenceBoundary), { excludeTestServices: true })(
  'native activity commands',
  (suite) => {
    suite.effect(
      'prepares remote permissions and references before SQL, then revalidates Principal eligibility',
      () => nativeActivityCommands,
    );
  },
);
