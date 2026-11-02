import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  ActiveApplicationCompositionService,
  OperationContextUnavailable,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, OccupancyConflict } from '../../shared/actions/apply-command.ts';
import { CommandReferenceValidators, prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { occupancyState } from '../../src/database/schema.ts';
import { unavailableOccupancyValidators } from '../../src/services/persistence.service.ts';

const unused = () => Effect.die('Unexpected production reference transport');
const nativeBoundary = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ReadRuntime, { runRead: unused }),
);
const nativePreparation = Effect.scoped(
  Effect.gen(function* nativePreparation() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: defineRelations({ occupancyState }) }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:reference-preparation',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'reference-preparation' };
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Fixture company missing',
      });
    }
    const resourceId = yield* crypto.randomUUIDv4();
    let insideTransaction = false;
    let referenceChecks = 0;
    let snapshotCount = 0;
    const context: ActionServicePreparationContext = {
      actionInvocationId: resourceId,
      compositionRevision: 'reference-preparation-composition',
      scope,
      transaction: (readSnapshot) =>
        database
          .transaction(
            Effect.fn('PreparationTest.snapshot')(function* snapshot(tx) {
              insideTransaction = true;
              snapshotCount += 1;
              const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
              return yield* readSnapshot(scoped);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                insideTransaction = false;
              }),
            ),
            Effect.mapError(
              () =>
                new OperationContextUnavailable({
                  code: 'operation_context_unavailable',
                  reason: 'Fixture snapshot failed',
                }),
            ),
          ),
    };
    const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'CreateDraft',
        record: {
          contractRef: null,
          customerCounterpartyRef: {
            moduleId: 'party.registry',
            resourceId,
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
          endDate: '2027-12-31',
          externalBookingCorrelation: null,
          guestPartyRef: null,
          kind: 'LONG_TERM_LEASE',
          note: null,
          occupancyRef: {
            moduleId: 'property.leasing',
            resourceId,
            resourceType: 'property.leasing.occupancy',
            tenantId: scope.tenantId,
          },
          peopleCount: null,
          startDate: '2026-11-02',
          state: 'DRAFT',
          unitRef: {
            moduleId: 'property.portfolio',
            resourceId,
            resourceType: 'property.portfolio.unit',
            tenantId: scope.tenantId,
          },
        },
      },
      expectedRevision: 0,
    });
    const assertOutsideSql = () => {
      expect(insideTransaction).toBe(false);
      expect(snapshotCount).toBe(1);
      referenceChecks += 1;
    };
    const validators: CommandReferenceValidators['Service'] = {
      ...unavailableOccupancyValidators,
      counterparty: (ref) =>
        Effect.sync(() => {
          assertOutsideSql();
          return { activeCustomer: true, archived: false, counterpartyRef: ref, legalEntityId };
        }),
      unit: (ref) =>
        Effect.sync(() => {
          assertOutsideSql();
          return { legalEntityId, lifecycleState: 'ACTIVE', unitRef: ref };
        }),
    };
    const factory = yield* prepareApplyCommandServices(payload, context).pipe(
      Effect.provideService(CommandReferenceValidators, validators),
    );
    const preparedChecks = referenceChecks;
    expect(preparedChecks).toBeGreaterThan(0);
    const result = yield* database
      .transaction(
        Effect.fn('PreparationTest.commit')(function* commit(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const services = yield* factory(scoped, scope, context.compositionRevision);
          const revision = yield* services.save(services.prepared.transition.snapshot, payload.expectedRevision);
          expect(revision).toBe(1);
          const current = yield* services.load();
          expect(current.revision).toBe(1);
          expect(current.snapshot.occupancies[0]?.state).toBe('DRAFT');
          const stale = yield* services
            .save(services.prepared.transition.snapshot, payload.expectedRevision)
            .pipe(Effect.flip);
          expect(Schema.is(OccupancyConflict)(stale)).toBe(true);
          for (const changedScope of [
            { ...scope, principalId: scope.tenantId },
            { ...scope, tenantId: scope.principalId },
            { ...scope, legalEntityId: scope.principalId },
            { ...scope, correlationId: 'another-operation' },
          ]) {
            expect(
              Schema.is(OperationContextUnavailable)(
                yield* factory(scoped, changedScope, context.compositionRevision).pipe(Effect.flip),
              ),
            ).toBe(true);
          }
          expect(
            Schema.is(OperationContextUnavailable)(
              yield* factory(scoped, scope, 'another-composition').pipe(Effect.flip),
            ),
          ).toBe(true);
          expect(referenceChecks).toBe(preparedChecks);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
    return yield* Effect.void;
  }),
);
it.layer(nativeBoundary, { excludeTestServices: true })('native command references', (suite) => {
  suite.effect(
    'releases the snapshot before remote validation and keeps final SQL revision CAS',
    () => nativePreparation,
  );
});
