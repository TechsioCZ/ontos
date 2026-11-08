import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/http';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Predicate } from 'effect';
import { and, eq } from 'drizzle-orm';
import { Reactivity } from 'effect/reactivity';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer } from '@app/core-runtime/testing/scripted-pg-client';
import { propertyLeasingRegistration } from '../../vertical.registration.ts';
import { occupancyState } from '../../src/database/schema.ts';
import { transitionOccupancy, unavailableOccupancyValidators } from '../../src/services/persistence.service.ts';
import type { OccupancyValidators } from '../../src/services/persistence.service.ts';
import { expect, it } from 'effect-rstest';

import { applyCommandAction, CommandReferenceValidators } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { leasesRead } from '../../src/search/leases.provider.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:lease-search-test',
  authMethod: 'session',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;

it.effect('governed rebuild needs an explicit Action grant, selected company, and idempotency', () =>
  Effect.gen(function* scenario() {
    const request = {
      payload: {},
      principal,
      registration: requestSearchRebuildAction,
      transport: { correlationId: 'lease-search-test', idempotencyKey: 'rebuild-1' },
    };
    const harness = yield* makeActionTestHarness({
      access: { 'property.leasing.request-search-rebuild.write': 'allowed' },
      ownerRegistration: propertyLeasingRegistration,
    });
    const first = yield* harness.runtime.runAction(request);
    expect(first.status).toBe('QUEUED');
    expect(
      Predicate.isTagged(yield* harness.runtime.runAction(request).pipe(Effect.flip), 'ActionAlreadyCommitted'),
    ).toBe(true);
    expect(harness.snapshot().committed.length).toBe(1);
    expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toEqual([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: { requestId: first.requestId },
          producerModuleKey: 'property.leasing',
          topic: 'property.leasing.search-rebuild-requested.v1',
        },
      },
    ]);
    const denied = yield* makeActionTestHarness({
      access: { 'property.leasing.request-search-rebuild.write': 'denied' },
      ownerRegistration: propertyLeasingRegistration,
    });
    expect(
      Predicate.isTagged(yield* denied.runtime.runAction(request).pipe(Effect.flip), 'ActionPermissionDenied'),
    ).toBe(true);
    expect(denied.snapshot().committed).toEqual([]);
    const noTenantAdministration = yield* makeActionTestHarness({
      access: {},
      ownerRegistration: propertyLeasingRegistration,
    });
    expect(
      Predicate.isTagged(
        yield* noTenantAdministration.runtime.runAction(request).pipe(Effect.flip),
        'ActionPermissionDenied',
      ),
    ).toBe(true);
    expect(noTenantAdministration.snapshot().committed).toEqual([]);
    expect(requestSearchRebuildAction.descriptor.accessDeclaration?.key).toBe(
      'property.leasing.request-search-rebuild.write',
    );
    expect(requestSearchRebuildAction.descriptor.legalEntityScope).toBe('required');
    expect(requestSearchRebuildAction.descriptor.entrypoint.authorization).toMatchObject({ kind: 'protected' });
  }),
);

const queryCompilationLayer = scriptedPgClientLayer(Effect.die('Query compilation must not acquire SQL')).pipe(
  Layer.provide(Reactivity.layer),
);
it.layer(queryCompilationLayer)('Leasing prepared business writes', (suite) => {
  suite.effect('successful business writes atomically queue projection intent and do not call the projector', () =>
    Effect.gen(function* scenario() {
      const payload = {
        command: {
          _tag: 'UpdateCounterpartyDossier',
          archived: true,
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: '40000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
        },
        expectedRevision: 0,
      } as const;
      const validators: OccupancyValidators = {
        ...unavailableOccupancyValidators,
        counterparty: (ref) =>
          Effect.succeed({
            activeCustomer: true,
            archived: false,
            counterpartyRef: ref,
            legalEntityId: principal.legalEntityId,
          }),
      };
      const transition = yield* transitionOccupancy(
        { occupancies: [] },
        payload.command,
        { legalEntityId: principal.legalEntityId, principalId: principal.principalId, tenantId },
        validators,
      );
      const queryBuilder = yield* testCoreDatabase;
      const snapshotQuery = queryBuilder
        .select()
        .from(occupancyState)
        .where(and(eq(occupancyState.tenantId, tenantId), eq(occupancyState.legalEntityId, principal.legalEntityId)))
        .limit(1)
        .toSQL();
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: propertyLeasingRegistration,
        preparationReads: [
          {
            execute: ({ params, scope }) => {
              expect(scope).toEqual({ legalEntityId: principal.legalEntityId, tenantId });
              expect(params).toEqual(snapshotQuery.params);
              return Effect.succeed([
                { legalEntityId: principal.legalEntityId, revision: 0, snapshot: { occupancies: [] }, tenantId },
              ]);
            },
            sql: snapshotQuery.sql,
          },
        ],
        services: [
          bindActionTestServices(applyCommandAction, {
            load: () => Effect.succeed({ revision: 0, snapshot: { occupancies: [] } }),
            prepared: { payload, transition },
            save: (snapshot) =>
              Effect.sync(() => {
                expect(snapshot.tenantDossiers?.[0]?.archived).toBe(true);
                return 1;
              }),
          }),
        ],
      });
      yield* harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'lease-search-test', idempotencyKey: 'create-1' },
        })
        .pipe(
          Effect.provideService(CommandReferenceValidators, validators),
          Effect.provideService(ActiveApplicationCompositionService, {
            load: Effect.die('Unexpected reference transport in a lifecycle-only test'),
          }),
          Effect.provideService(GatewayPrincipalVerifierConfiguration, {
            configuration: Effect.die('Unexpected gateway configuration in a lifecycle-only test'),
          }),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request('https://ontos.test/lease-search')),
          ),
        );
      const { committed } = harness.snapshot();
      expect(committed.length).toBe(1);
      expect(committed[0]?.evidence.outboxMessages[0]?.message.topic).toBe(
        'property.leasing.search-refresh-requested.v1',
      );
      expect(committed[0]?.evidence.domainEvents.length).toBe(1);
    }),
  );
});

it('registers the candidate-checked provider and both governed owner workers', () => {
  expect(leasesRead.descriptor.legalEntityScope).toBe('required');
  expect(leasesRead.descriptor.accessDeclaration?.key).toBe('property.leasing.search-leases.read');
  expect(outboxWorkers.map((worker) => worker.descriptor.workerKey).toSorted()).toEqual([
    'property.leasing.rebuild-search',
    'property.leasing.refresh-search',
  ]);
});
