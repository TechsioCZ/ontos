import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import {
  ActiveApplicationCompositionService,
  DatabaseIdentityEnrollmentContext,
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { Layer, Crypto, Effect, Option, Redacted, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import type { OperationalScope } from '@app/core-runtime';
import {
  bindActionTestServices,
  installOperationalScope,
  makeActionPreparationProbe,
  makeActionTestHarness,
} from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';

import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  CrmReferenceUnavailable,
  CrmRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { assignmentPolicy } from '../../src/services/assignment-policy.ts';
import { crmRelations } from '../../src/database/schema.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import {
  crmApplyCommandDeclaration,
  crmClientOwnerAssignGroup,
  crmRecordsReadDeclaration,
} from '../../shared/domain/access-declarations.ts';
import { crmRegistration } from '../../vertical.registration.ts';

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
    const coreExecutor = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, client));
    const enrollment = defineDatabaseIdentityEnrollment([]);
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
    const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: crmRegistration });
    const compositionRevision = owner.snapshot.composition.revision;
    // The real preparation and Policy run through Core. Bound services replace consumption only:
    // the probe retains each exact original factory, uninvoked, for the native owner checks below.
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: owner.applicationComposition,
      expectedDeployment: owner.expectedDeployment,
      ownerRegistration: crmRegistration,
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: (_command, expectedRevision) => Effect.succeed({ entityIds: [], revision: expectedRevision + 1 }),
          loadAssignmentDirectory: unusedReference,
          loadRecords: unusedReference,
        }),
      ],
    });
    let insideTransaction = false;
    let permissionChecks = 0;
    const gate = makeTestAccessDecision({
      answers: {
        [crmApplyCommandDeclaration.key]: { outcome: 'ALLOWED' },
        [crmClientOwnerAssignGroup.key]: { outcome: 'ALLOWED' },
        [crmRecordsReadDeclaration.key]: { outcome: 'ALLOWED', predicate: { groups: [] } },
      },
    });
    const assertOutsideSql = () => expect(insideTransaction).toBe(false);
    const access = {
      ...gate,
      decide: (question: Parameters<typeof gate.decide>[0]) =>
        Effect.sync(assertOutsideSql).pipe(Effect.andThen(gate.decide(question))),
      decideMany: (question: Parameters<typeof gate.decideMany>[0]) =>
        Effect.sync(() => {
          assertOutsideSql();
          permissionChecks += 1;
        }).pipe(Effect.andThen(gate.decideMany(question))),
      list: (question: Parameters<typeof gate.list>[0]) =>
        Effect.sync(assertOutsideSql).pipe(Effect.andThen(gate.list(question))),
    };
    const create = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'CreateClient',
        kind: 'organization',
        name: 'Regresní test',
      },
      expectedRevision: 0,
    });
    const createKey = `${resourceId}-create`;
    const createProbe = makeActionPreparationProbe(applyCommandAction);
    expect(Option.isNone(createProbe.snapshot())).toBe(true);
    yield* harness.runtime
      .runAction(
        createProbe.input({
          payload: create,
          principal,
          transport: { correlationId: scope.correlationId, idempotencyKey: createKey },
        }),
      )
      .pipe(
        Effect.provideService(AccessDecisionGate, access),
        Effect.provideService(CoreDatabase, { executor: coreExecutor }),
        Effect.provideService(DatabaseIdentityEnrollmentContext, enrollment),
      );
    const createFactory = Option.getOrThrow(createProbe.snapshot());
    const createInvocationId = Option.getOrThrow(
      Option.fromUndefinedOr(harness.snapshot().invocations.find(({ idempotencyKey }) => idempotencyKey === createKey)),
    ).actionInvocationId;
    const clientId = `${createInvocationId}-client`;
    const update = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: { _tag: 'UpdateClient', id: clientId, patch: { name: 'Upravený klient' } },
      expectedRevision: 1,
    });
    const updateKey = `${resourceId}-update`;
    const updateProbe = makeActionPreparationProbe(applyCommandAction);
    expect(Option.isNone(updateProbe.snapshot())).toBe(true);
    yield* harness.runtime
      .runAction(
        updateProbe.input({
          payload: update,
          principal,
          transport: { correlationId: scope.correlationId, idempotencyKey: updateKey },
        }),
      )
      .pipe(
        Effect.provideService(AccessDecisionGate, access),
        Effect.provideService(CoreDatabase, { executor: coreExecutor }),
        Effect.provideService(DatabaseIdentityEnrollmentContext, enrollment),
      );
    const updateFactory = Option.getOrThrow(updateProbe.snapshot());
    const updateInvocationId = Option.getOrThrow(
      Option.fromUndefinedOr(harness.snapshot().invocations.find(({ idempotencyKey }) => idempotencyKey === updateKey)),
    ).actionInvocationId;
    expect(harness.snapshot().policyDenials).toEqual([]);
    expect(harness.snapshot().committed).toHaveLength(2);
    for (const committed of harness.snapshot().committed) {
      expect(committed.allowedPolicies).toContainEqual({
        owningModuleKey: 'demo.crm',
        policyKey: assignmentPolicy.policyKey,
        scope: 'microvertical',
      });
    }
    expect(permissionChecks).toBe(2);
    const result = yield* database
      .transaction(
        Effect.fn('CrmCommandsTest.transaction')(function* nativeTransaction(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, enrollment);
          const creator = yield* createFactory(scoped, scope, compositionRevision);
          const created = yield* creator.apply(create.command, 0, createInvocationId);
          expect(created.revision).toBe(1);
          expect(created.entityIds).toEqual([clientId]);
          const updater = yield* updateFactory(scoped, scope, compositionRevision);
          const updated = yield* updater.apply(update.command, 1, updateInvocationId);
          expect(updated).toMatchObject({ entityIds: [clientId], revision: 2 });
          const stale = yield* updater.apply(update.command, 1, updateInvocationId).pipe(Effect.flip);
          expect(Schema.is(CrmRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1, updateInvocationId).pipe(Effect.flip);
          expect(Schema.is(CrmReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(CrmReferenceUnavailable)(
              yield* unprepared.apply(create.command, 0, createInvocationId).pipe(Effect.flip),
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
                yield* updateFactory(scoped, other, compositionRevision).pipe(Effect.flip),
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
      .pipe(Effect.provideService(AccessDecisionGate, access), Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
);

it.layer(Layer.mergeAll(NodeCrypto.layer, referenceBoundary, makeTestAccessGateLayers()), {
  excludeTestServices: true,
})('native crm commands', (suite) => {
  suite.effect('prepares permissions outside SQL; revalidates identity, payload and revision', () => nativeCrmCommands);
});
