import { v1 } from '@authzed/authzed-node';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Predicate, Redacted, Result, Schema } from 'effect';
import { assert, expect, it, rs } from 'effect-rstest';

import {
  buildActionAuthorizationRelationships,
  buildExplicitActionGrantRelationships,
} from '../../src/install/action-authorization-provisioning.ts';

import { legalEntities, principalAuthBindings, principals, tenantModuleStates, tenants } from '../../src/db/schema.ts';
import {
  toContextPermissionAccessObjectId,
  toIdentityNamespaceAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../src/permissions/context-access.ts';

import {
  makeLiveOperationFixture,
  makeLiveOperationFixtureRuntime,
  makeLiveOperationFixtureBootstrap,
  LiveOperationFixtureRuntimeHandoffSchema,
  LiveOperationFixtureBootstrapRequestSchema,
} from '../../src/testing/live-operations.ts';
import { toSpiceDbActionObjectId } from '../../src/permissions/service.ts';

type FixtureReadTable =
  | typeof principals
  | typeof legalEntities
  | typeof tenants
  | typeof principalAuthBindings
  | typeof tenantModuleStates;
type FixtureServiceRow = Pick<typeof principals.$inferSelect, 'kind' | 'principalId' | 'status' | 'tenantId'>;
type FixtureEntityRow = Pick<typeof legalEntities.$inferSelect, 'legalEntityId' | 'status' | 'tenantId'>;
type FixtureReadRow =
  | FixtureServiceRow
  | FixtureEntityRow
  | Pick<typeof tenants.$inferInsert, 'tenantId' | 'status'>
  | typeof principalAuthBindings.$inferInsert
  | typeof tenantModuleStates.$inferInsert;

type FixtureInsertTable =
  | typeof legalEntities
  | typeof principalAuthBindings
  | typeof principals
  | typeof tenantModuleStates
  | typeof tenants;
type FixtureInsertRow =
  | typeof legalEntities.$inferInsert
  | typeof principalAuthBindings.$inferInsert
  | typeof principals.$inferInsert
  | typeof tenantModuleStates.$inferInsert
  | typeof tenants.$inferInsert;
type FixtureInsertValues = FixtureInsertRow | readonly FixtureInsertRow[];

class FixtureModuleStateUpdateFailure extends Schema.TaggedError<FixtureModuleStateUpdateFailure>()(
  'FixtureModuleStateUpdateFailure',
  {},
) {}

const transport = rs.hoisted(() => ({
  checkPermission: rs.fn<(request: v1.CheckPermissionRequest) => Promise<v1.CheckPermissionResponse>>(),
  insert: rs.fn<(table: FixtureInsertTable, value: FixtureInsertValues) => void>(),
  nativeRows: rs.fn<
    () => readonly {
      readonly bypass: boolean;
      readonly createDb: boolean;
      readonly createRole: boolean;
      readonly database: string;
      readonly role: string;
      readonly session: string;
      readonly superuser: boolean;
    }[]
  >(),
  selectRows: rs.fn<(table: FixtureReadTable, predicate?: SQL) => readonly FixtureReadRow[]>(),
  updateRows:
    rs.fn<
      (
        table: typeof tenantModuleStates,
        values: { readonly state: string },
        predicate: SQL,
      ) => Effect.Effect<
        readonly { readonly moduleKey: string; readonly tenantId: string }[],
        FixtureModuleStateUpdateFailure
      >
    >(),
  writeRelationships: rs.fn<(request: v1.WriteRelationshipsRequest) => Promise<v1.WriteRelationshipsResponse>>(),
}));

const fixtureInsert = (table: FixtureInsertTable) => ({
  values: (value: FixtureInsertValues) => Effect.sync(() => transport.insert(table, value)),
});

const fixtureSelect = () => ({
  from: (table: FixtureReadTable) => ({
    where: (predicate?: SQL) => Effect.sync(() => transport.selectRows(table, predicate)),
  }),
});

const fixtureUpdate = (table: typeof tenantModuleStates) => ({
  set: (values: { readonly state: string }) => ({
    where: (predicate: SQL) => ({
      returning: () => transport.updateRows(table, values, predicate),
    }),
  }),
});

// Only external connections are replaced. The public fixture generates its actors and provisions its real tuples.
rs.mock('../../src/db/client.ts', () => ({
  ...rs.requireActual('../../src/db/client.ts'),
  makeCoreDatabase: () => {
    const executor = {
      execute: () => Effect.sync(() => transport.nativeRows()),
      insert: fixtureInsert,
      select: fixtureSelect,
      update: fixtureUpdate,
    };
    return Effect.succeed({
      executor: {
        ...executor,
        transaction: <Value, Failure, Requirements>(
          operation: (transaction: typeof executor) => Effect.Effect<Value, Failure, Requirements>,
        ) => operation(executor),
      },
    });
  },
}));
rs.mock('../../src/permissions/config.ts', () => ({
  ...rs.requireActual('../../src/permissions/config.ts'),
  loadSpiceDbConfig: () => Effect.succeed({ endpoint: 'localhost:50051', preSharedKey: 'unit-only' }),
}));
rs.mock('../../src/permissions/spicedb-grpc-rpc.ts', () => ({
  ...rs.requireActual('../../src/permissions/spicedb-grpc-rpc.ts'),
  newSpiceDbGrpcClient: () => ({
    close: () => {},
    promises: { checkPermission: transport.checkPermission, writeRelationships: transport.writeRelationships },
  }),
}));

const configuration = {
  actionKeys: ['commerce.catalog.activate-local-override', 'commerce.catalog.change-local-override'],
  adminConnectionString: Redacted.make('postgresql://unit_admin:unit@127.0.0.1/unit'),
  authenticationNamespaceId: 'fixture-manager-unit',
  compositionRevision: 'a'.repeat(64),
  runtimeConnectionString: Redacted.make('postgresql://unit:unit@127.0.0.1/unit'),
};

const commerceProvisioningNamespace = 'ontos.commerce.portal.better-auth.v1';
const namespaceResourceType = 'identity_namespace';

const existingServiceId = '00000000-0000-4000-8000-000000001257';
const mockExistingService = (fixture: { readonly legalEntityId: string; readonly tenantId: string }) => {
  const service: FixtureServiceRow = {
    kind: 'service',
    principalId: existingServiceId,
    status: 'active',
    tenantId: fixture.tenantId,
  };
  const entity: FixtureEntityRow = {
    legalEntityId: fixture.legalEntityId,
    status: 'active',
    tenantId: fixture.tenantId,
  };
  transport.selectRows.mockImplementation((table) => (table === principals ? [service] : [entity]));
  return { entity, service };
};
const permissionResponse = (allowed: boolean) =>
  v1.CheckPermissionResponse.create({
    permissionship: allowed
      ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
      : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
  });

it.layer(NodeCrypto.layer)('live operation fixture', (suite) => {
  suite.effect('revokes and restores only its exact seeded primary-LE manager module accessor', () =>
    Effect.gen(function* mutateOnlyOwnedManagerAccessor() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, additionalLegalEntity: 'same-tenant' });
      const moduleObject = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      assert(moduleObject !== undefined);
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      for (const [operation, expectedOperation] of [
        ['revoke', v1.RelationshipUpdate_Operation.DELETE],
        ['grant', v1.RelationshipUpdate_Operation.TOUCH],
      ] as const) {
        yield* fixture.changeManagerModuleAccess('party.registry', operation);
        expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual([
          v1.RelationshipUpdate.create({
            operation: expectedOperation,
            relationship: v1.Relationship.create({
              relation: 'accessor',
              resource: { objectId: moduleObject, objectType: 'module_access' },
              subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
            }),
          }),
        ]);
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 2);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('updates one configured module in its fixed Tenant and returns authoritative readback', () =>
    Effect.gen(function* changeConfiguredModuleState() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const originalHandoff = yield* Schema.encodeEffect(
        Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema),
      )(fixture.runtimeHandoff);
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeUpdate = transport.updateRows.mock.calls.length;
      const beforeSelect = transport.selectRows.mock.calls.length;
      transport.updateRows.mockReturnValue(Effect.succeed([{ moduleKey, tenantId: fixture.tenantId }]));
      for (const state of ['suspended', 'active'] as const) {
        transport.selectRows.mockReturnValue([{ moduleKey, state, tenantId: fixture.tenantId }]);
        expect(yield* fixture.setConfiguredModuleState(moduleKey, state)).toEqual({ moduleKey, state });
        const update = transport.updateRows.mock.lastCall;
        assert(update !== undefined);
        expect(update[0]).toBe(tenantModuleStates);
        expect(update[1]).toEqual({ state });
        expect(new PgDialect().sqlToQuery(update[2]).params).toEqual([fixture.tenantId, moduleKey]);
        const read = transport.selectRows.mock.lastCall;
        assert(read !== undefined && read[1] !== undefined);
        expect(read[0]).toBe(tenantModuleStates);
        expect(new PgDialect().sqlToQuery(read[1]).params).toEqual([fixture.tenantId, moduleKey]);
      }
      expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate + 2);
      expect(transport.selectRows).toHaveBeenCalledTimes(beforeSelect + 2);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
          fixture.runtimeHandoff,
        ),
      ).toBe(originalHandoff);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unknown module keys, unsupported states and extra setter inputs before mutation', () =>
    Effect.gen(function* rejectUnboundedModuleStateMutation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const beforeUpdate = transport.updateRows.mock.calls.length;
      const beforeSelect = transport.selectRows.mock.calls.length;
      for (const key of ['commerce.unknown', '*', '', 'commerce.customer-context.*']) {
        const failure = yield* Effect.flip(fixture.setConfiguredModuleState(key, 'suspended'));
        expect(failure.reason).toBe('Invalid configured fixture module state mutation');
      }
      for (const state of ['quarantined', 'read_only', 'unknown', '*']) {
        const failure = yield* Effect.flip(
          // @ts-expect-error Runtime callers cannot request unsupported or unknown module states.
          fixture.setConfiguredModuleState(moduleKey, state),
        );
        expect(failure.reason).toBe('Invalid configured fixture module state mutation');
      }
      const extra = yield* Effect.flip(
        // @ts-expect-error Extra tenant selectors must not alter the captured fixture scope.
        fixture.setConfiguredModuleState(moduleKey, 'suspended', { tenantId: 'foreign' }),
      );
      expect(extra.reason).toBe('Invalid configured fixture module state mutation');
      expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate);
      expect(transport.selectRows).toHaveBeenCalledTimes(beforeSelect);
      yield* fixture.close();
    }),
  );

  suite.effect('preserves typed update and authoritative readback failures without inserting missing modules', () =>
    Effect.gen(function* rejectUnverifiedModuleStateMutation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const beforeInsert = transport.insert.mock.calls.length;
      transport.updateRows.mockReturnValueOnce(Effect.fail(new FixtureModuleStateUpdateFailure({})));
      const failed = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
      expect(failed.reason).toBe('Unable to persist configured fixture module state');
      transport.updateRows.mockReturnValueOnce(Effect.succeed([]));
      const missing = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
      expect(missing.reason).toBe('Configured fixture module state update did not match exactly one existing row');
      transport.updateRows.mockReturnValue(Effect.succeed([{ moduleKey, tenantId: fixture.tenantId }]));
      for (const rows of [
        [],
        [{ moduleKey, state: 'active', tenantId: fixture.tenantId }],
        [{ moduleKey, state: 'suspended', tenantId: 'foreign' }],
        [{ moduleKey: 'commerce.unknown', state: 'suspended', tenantId: fixture.tenantId }],
      ]) {
        transport.selectRows.mockReturnValue(rows);
        const contradictory = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
        expect(contradictory.reason).toBe('Configured fixture module state readback did not match the update');
      }
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('admits explicitly configured seeded module access and rejects unseeded modules before transport', () =>
    Effect.gen(function* enforceOwnedManagerModuleAllowlist() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const input of [
        configuration,
        { ...configuration, moduleAccess: 'configured-modules' as const, moduleKeys: ['privacy.core'] },
      ]) {
        const fixture = yield* makeLiveOperationFixture(input);
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const allowed = 'moduleAccess' in input;
        if (allowed) {
          yield* fixture.changeManagerModuleAccess('privacy.core', 'revoke');
          expect(transport.writeRelationships.mock.lastCall?.[0].updates).toMatchObject([
            {
              operation: v1.RelationshipUpdate_Operation.DELETE,
              relationship: {
                relation: 'accessor',
                resource: {
                  objectId: toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'privacy.core'),
                  objectType: 'module_access',
                },
                subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
              },
            },
          ]);
        }
        const cases = allowed ? ['commerce.unknown', '*', ''] : ['privacy.core', 'commerce.unknown', '*', ''];
        for (const moduleKey of cases) {
          const failure = yield* Effect.flip(fixture.changeManagerModuleAccess(moduleKey, 'grant'));
          expect(failure.reason).toBe('Module access mutation requires a fixture-owned manager grant');
        }
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + (allowed ? 1 : 0));
        yield* fixture.close();
      }
    }),
  );

  suite.effect('returns a typed module-access mutation failure without alternate grants when transport fails', () =>
    Effect.gen(function* preserveAccessorTransportFailure() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      transport.writeRelationships.mockRejectedValueOnce(new Error('unit-only write failure'));
      const failure = yield* Effect.flip(fixture.changeManagerModuleAccess('party.registry', 'revoke'));
      expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
      expect(failure.reason).toBe('Unable to change live fixture manager module access');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('child permission environment exposes only validated parser keys with a redacted credential', () =>
    Effect.gen(function* exposeBoundedPermissionEnvironment() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      expect(Object.keys(fixture.permissionEnvironment).toSorted()).toEqual([
        'SPICEDB_ENDPOINT',
        'SPICEDB_PRESHARED_KEY',
      ]);
      expect(fixture.permissionEnvironment.SPICEDB_ENDPOINT).toBe('localhost:50051');
      expect(Redacted.isRedacted(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY)).toBe(true);
      expect(Redacted.value(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY)).toBe('unit-only');
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture.permissionEnvironment);
      expect(encoded).not.toContain('unit-only');
      expect(Object.isFrozen(fixture.permissionEnvironment)).toBe(true);
      yield* fixture.close();
    }),
  );

  suite.effect('grants only an existing native active service the declared module and explicit Action tuples', () =>
    Effect.gen(function* grantExactExistingService() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleAccess: 'configured-modules',
        moduleKeys: ['commerce.catalog'],
      });
      mockExistingService(fixture);
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      yield* fixture.grantExistingService({
        actionKeys: configuration.actionKeys,
        legalEntityId: fixture.legalEntityId,
        moduleKeys: ['commerce.catalog'],
        principalId: existingServiceId,
      });
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
      const updates = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates;
      expect(updates?.every((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
      const tuples = updates?.flatMap((update) => (update.relationship === undefined ? [] : [update.relationship]));
      expect(tuples).toHaveLength(7);
      expect(tuples?.filter(({ resource }) => resource?.objectType === 'action')).toEqual(
        buildExplicitActionGrantRelationships(
          configuration.actionKeys.map((actionKey) => ({ actionKey, principalIds: [existingServiceId] })),
        ),
      );
      expect(
        tuples?.some(({ relation }) =>
          ['identity_admin', 'counterparty_manager', 'counterparty_reader'].includes(relation),
        ),
      ).toBe(false);
      expect(
        tuples?.filter(({ relation, resource }) => resource?.objectType === 'legal_entity' && relation === 'member'),
      ).toMatchObject([{ subject: { object: { objectId: existingServiceId } } }]);
      const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
      expect(checks).toHaveLength(5);
      expect(checks.every((request) => request.consistency?.requirement.oneofKind === 'fullyConsistent')).toBe(true);
      expect(checks.every((request) => request.subject?.object?.objectId === existingServiceId)).toBe(true);
      expect(
        checks
          .filter((request) => request.resource?.objectType === 'action')
          .map((request) => request.resource?.objectId),
      ).toEqual(configuration.actionKeys.map(toSpiceDbActionObjectId));
      yield* fixture.close();
    }),
  );

  suite.effect('read-only service grants no executor and verifies undeclared Actions and modules stay denied', () =>
    Effect.gen(function* grantReadOnlyService() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog', 'party.registry'],
      });
      mockExistingService(fixture);
      const excludedModule = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      transport.checkPermission.mockImplementation((request) =>
        Promise.resolve(
          permissionResponse(
            request.resource?.objectType !== 'action' && request.resource?.objectId !== excludedModule,
          ),
        ),
      );
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      yield* fixture.grantExistingService({
        actionKeys: [],
        legalEntityId: fixture.legalEntityId,
        moduleKeys: ['commerce.catalog'],
        principalId: existingServiceId,
      });
      const tuples = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      expect(tuples).toHaveLength(5);
      expect(tuples?.some(({ resource }) => resource?.objectType === 'action')).toBe(false);
      const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
      expect(checks.filter((request) => request.permission === 'execute')).toHaveLength(
        configuration.actionKeys.length * 2,
      );
      expect(checks.some((request) => request.resource?.objectId === excludedModule)).toBe(true);
      yield* fixture.close();
    }),
  );

  suite.effect('service membership must not activate latent excluded Action or module permissions', () =>
    Effect.gen(function* rejectMembershipActivatedGrants() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const latentKind of ['action', 'module_access']) {
        const fixture = yield* makeLiveOperationFixture({
          ...configuration,
          actionExecutor: 'manager-only',
          moduleKeys: ['commerce.catalog', 'party.registry'],
        });
        mockExistingService(fixture);
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const excludedModule = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
        transport.checkPermission.mockImplementation((request) => {
          const excluded = request.resource?.objectType === 'action' || request.resource?.objectId === excludedModule;
          const membershipWritten = transport.writeRelationships.mock.calls.length > beforeWrite;
          return Promise.resolve(
            permissionResponse(!excluded || (membershipWritten && request.resource?.objectType === latentKind)),
          );
        });
        const beforeCheck = transport.checkPermission.mock.calls.length;
        const failure = yield* Effect.flip(
          fixture.grantExistingService({
            actionKeys: [],
            legalEntityId: fixture.legalEntityId,
            moduleKeys: ['commerce.catalog'],
            principalId: existingServiceId,
          }),
        );
        expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
        expect(
          transport.checkPermission.mock.calls
            .slice(beforeCheck)
            .every(([request]) => request.consistency?.requirement.oneofKind === 'fullyConsistent'),
        ).toBe(true);
        yield* fixture.close();
      }
    }),
  );

  suite.effect(
    'service grants reject unknown, wildcard, duplicate, empty and cross-module declarations before writing',
    () =>
      Effect.gen(function* rejectUnboundedServiceGrants() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const fixture = yield* makeLiveOperationFixture({
          ...configuration,
          actionExecutor: 'manager-only',
          moduleKeys: ['commerce.catalog', 'party.registry'],
        });
        mockExistingService(fixture);
        const valid = {
          actionKeys: configuration.actionKeys,
          legalEntityId: fixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        };
        const cases = [
          { ...valid, moduleKeys: [] },
          { ...valid, moduleKeys: ['*'] },
          { ...valid, moduleKeys: [''] },
          { ...valid, moduleKeys: ['commerce.catalog', 'commerce.catalog'] },
          { ...valid, moduleKeys: ['commerce.unknown'] },
          { ...valid, actionKeys: ['*'] },
          { ...valid, actionKeys: [''] },
          { ...valid, actionKeys: ['commerce.catalog.unlisted'] },
          { ...valid, actionKeys: [configuration.actionKeys[0] ?? '', configuration.actionKeys[0] ?? ''] },
          { ...valid, moduleKeys: ['party.registry'] },
          { ...valid, legalEntityId: '00000000-0000-4000-8000-000000000001' },
        ];
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const input of cases) {
          const failure = yield* Effect.flip(fixture.grantExistingService(input));
          expect(failure.reason).toBe('Invalid existing service fixture authorization');
        }
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* fixture.close();
      }),
  );

  suite.effect('service grants require one exact active persisted service and primary same-Tenant Legal Entity', () =>
    Effect.gen(function* rejectForeignOrInactiveServiceRows() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog'],
      });
      const rows = mockExistingService(fixture);
      const cases: readonly {
        readonly entities: readonly FixtureEntityRow[];
        readonly services: readonly FixtureServiceRow[];
      }[] = [
        { entities: [rows.entity], services: [] },
        { entities: [rows.entity], services: [{ ...rows.service, kind: 'human' }] },
        { entities: [rows.entity], services: [{ ...rows.service, status: 'disabled' }] },
        { entities: [rows.entity], services: [{ ...rows.service, tenantId: '00000000-0000-4000-8000-000000000001' }] },
        { entities: [rows.entity], services: [{ ...rows.service, principalId: fixture.manager.principalId }] },
        { entities: [rows.entity], services: [rows.service, rows.service] },
        { entities: [], services: [rows.service] },
        { entities: [{ ...rows.entity, status: 'suspended' }], services: [rows.service] },
        { entities: [{ ...rows.entity, tenantId: '00000000-0000-4000-8000-000000000001' }], services: [rows.service] },
      ];
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      for (const testCase of cases) {
        transport.selectRows.mockImplementation((table) =>
          table === principals ? testCase.services : testCase.entities,
        );
        const failure = yield* Effect.flip(
          fixture.grantExistingService({
            actionKeys: configuration.actionKeys,
            legalEntityId: fixture.legalEntityId,
            moduleKeys: ['commerce.catalog'],
            principalId: existingServiceId,
          }),
        );
        expect(failure.reason).toBe('Invalid existing service fixture authorization');
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      yield* fixture.close();
    }),
  );

  suite.effect('service grants reject membership-default executors and preexisting undeclared permissions', () =>
    Effect.gen(function* rejectImplicitServiceExecutors() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const membershipFixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.catalog'] });
      const membershipBefore = transport.writeRelationships.mock.calls.length;
      const membershipFailure = yield* Effect.flip(
        membershipFixture.grantExistingService({
          actionKeys: [],
          legalEntityId: membershipFixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        }),
      );
      expect(membershipFailure.reason).toBe('Invalid existing service fixture authorization');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(membershipBefore);
      yield* membershipFixture.close();
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog'],
      });
      mockExistingService(fixture);
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const before = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        fixture.grantExistingService({
          actionKeys: [],
          legalEntityId: fixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        }),
      );
      expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
      yield* fixture.close();
    }),
  );

  suite.effect('namespace provisioning is exact, opt-in, verified and removed on close', () =>
    Effect.gen(function* exactOwnedNamespaceProvisioning() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockImplementation((request) => {
        const grantee = transport.writeRelationships.mock.calls
          .at(-1)?.[0]
          .updates.find((update) => update.relationship?.relation === 'provisioner')?.relationship?.subject
          ?.object?.objectId;
        return Promise.resolve(permissionResponse(request.subject?.object?.objectId === grantee));
      });
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        managerIdentityAdmin: true,
        managerProvisioningNamespaces: [commerceProvisioningNamespace],
      });
      const resourceId = toIdentityNamespaceAccessObjectId(fixture.tenantId, commerceProvisioningNamespace);
      assert(resourceId !== undefined);
      const granted = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.filter(
        (update) => update.relationship?.resource?.objectType === namespaceResourceType,
      );
      expect(granted).toEqual([
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'tenant',
            resource: { objectId: resourceId, objectType: namespaceResourceType },
            subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } },
          }),
        }),
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'provisioner',
            resource: { objectId: resourceId, objectType: namespaceResourceType },
            subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
          }),
        }),
      ]);
      const checks = transport.checkPermission.mock.calls
        .slice(beforeCheck)
        .map(([request]) => request)
        .filter((request) => request.resource?.objectType === namespaceResourceType);
      expect(checks).toHaveLength(4);
      expect(
        checks.every(
          (request) =>
            request.resource?.objectId === resourceId &&
            request.permission === 'provision' &&
            request.consistency?.requirement.oneofKind === 'fullyConsistent',
        ),
      ).toBe(true);
      expect(new Set(checks.map((request) => request.subject?.object?.objectId))).toEqual(
        new Set([
          fixture.manager.principalId,
          fixture.reader.principalId,
          fixture.denied.principalId,
          fixture.legalEntityOnly.principalId,
        ]),
      );
      yield* fixture.close();
      expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual(
        granted?.map((update) => ({ ...update, operation: v1.RelationshipUpdate_Operation.DELETE })),
      );
    }),
  );

  suite.effect('default fixture creates no namespace provisioning relationships', () =>
    Effect.gen(function* noImplicitNamespaceProvisioning() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture(configuration);
      expect(
        transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.some(
          (update) => update.relationship?.resource?.objectType === namespaceResourceType,
        ),
      ).toBe(false);
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
    }),
  );

  suite.effect('namespace provisioning rejects unbounded or implicit setup before writes', () =>
    Effect.gen(function* rejectInvalidNamespaceProvisioning() {
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeInsert = transport.insert.mock.calls.length;
      for (const namespaces of [[], [''], ['*'], ['same', 'same']]) {
        yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            actionExecutor: 'manager-only',
            managerIdentityAdmin: true,
            managerProvisioningNamespaces: namespaces,
          }),
        );
      }
      for (const options of [{}, { managerIdentityAdmin: true }, { actionExecutor: 'manager-only' as const }]) {
        yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            ...options,
            managerProvisioningNamespaces: [commerceProvisioningNamespace],
          }),
        );
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
    }),
  );

  suite.effect('identity administration is opt-in and verifies only the fixture manager is allowed', () =>
    Effect.gen(function* grantManagerIdentityAdministration() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockImplementation((request) => {
        const grantee = transport.writeRelationships.mock.calls
          .at(-1)?.[0]
          .updates.find((update) => update.relationship?.relation === 'identity_admin')?.relationship?.subject
          ?.object?.objectId;
        return Promise.resolve(permissionResponse(request.subject?.object?.objectId === grantee));
      });
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({ ...configuration, managerIdentityAdmin: true });
      const tuples = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship?.relation === 'identity_admin' ? [update.relationship] : [],
      );
      expect(tuples).toMatchObject([
        {
          resource: { objectId: fixture.tenantId, objectType: 'tenant' },
          subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
        },
      ]);
      expect(tuples).toHaveLength(1);
      const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
      expect(checks).toHaveLength(4);
      expect(
        checks.every(
          (request) =>
            request.resource?.objectId === fixture.tenantId &&
            request.permission === 'manage_identity' &&
            request.consistency?.requirement.oneofKind === 'fullyConsistent',
        ),
      ).toBe(true);
      expect(new Set(checks.map((request) => request.subject?.object?.objectId))).toEqual(
        new Set([
          fixture.manager.principalId,
          fixture.legalEntityOnly.principalId,
          fixture.denied.principalId,
          fixture.reader.principalId,
        ]),
      );
      yield* fixture.close();
    }),
  );

  suite.effect('default and disabled identity administration retain original grants without extra checks', () =>
    Effect.gen(function* preserveDefaultIdentityAdministration() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const input of [configuration, { ...configuration, managerIdentityAdmin: false }]) {
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const beforeCheck = transport.checkPermission.mock.calls.length;
        const fixture = yield* makeLiveOperationFixture(input);
        expect(
          transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.some(
            (update) => update.relationship?.relation === 'identity_admin',
          ),
        ).toBe(false);
        expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
        yield* fixture.close();
      }
    }),
  );

  suite.effect('identity administration rejects unexpected permission to another actor', () =>
    Effect.gen(function* rejectIdentityPrivilegeLeak() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const failure = yield* Effect.flip(makeLiveOperationFixture({ ...configuration, managerIdentityAdmin: true }));
      expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
    }),
  );

  suite.effect('configured module access grants only the primary Legal Entity manager and LE-only actor', () =>
    Effect.gen(function* grantConfiguredModuleAccess() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        additionalLegalEntity: 'same-tenant',
        moduleAccess: 'configured-modules',
        moduleKeys: ['privacy.core', 'commerce.catalog', 'party.registry'],
      });
      assert(fixture.secondaryLegalEntity !== undefined);
      const relations = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      const modules = relations?.filter(({ resource }) => resource?.objectType === 'module_access');
      const primaryParty = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      const privacy = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'privacy.core');
      const catalog = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'commerce.catalog');
      const secondaryParty = toModuleAccessObjectId(
        fixture.tenantId,
        fixture.secondaryLegalEntity.legalEntityId,
        'party.registry',
      );
      expect(new Set(modules?.map(({ resource }) => resource?.objectId))).toEqual(
        new Set([primaryParty, privacy, catalog, secondaryParty]),
      );
      expect(modules).toHaveLength(11);
      const entityObject = toLegalEntityAccessObjectId(fixture.tenantId, fixture.legalEntityId);
      for (const objectId of [primaryParty, privacy, catalog]) {
        const exactModule = modules?.filter(({ resource }) => resource?.objectId === objectId);
        expect(exactModule).toHaveLength(3);
        expect(exactModule?.filter(({ relation }) => relation === 'legal_entity')).toMatchObject([
          { subject: { object: { objectId: entityObject, objectType: 'legal_entity' } } },
        ]);
        expect(
          exactModule?.filter(({ relation }) => relation === 'accessor').map(({ subject }) => subject?.object),
        ).toEqual([
          { objectId: fixture.manager.principalId, objectType: 'principal' },
          { objectId: fixture.legalEntityOnly.principalId, objectType: 'principal' },
        ]);
      }
      expect(relations?.some(({ resource }) => resource?.objectType === 'context_permission')).toBe(false);
      expect(relations?.some(({ resource }) => resource?.objectType === 'resource')).toBe(false);
      expect(relations?.filter(({ resource }) => resource?.objectType === 'action')).toEqual(
        buildExplicitActionGrantRelationships(
          configuration.actionKeys.map((actionKey) => ({ actionKey, principalIds: [fixture.manager.principalId] })),
        ),
      );
      const beforeClose = transport.writeRelationships.mock.calls.length;
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeClose);
    }),
  );

  suite.effect('module state configuration alone retains the original Party-only module authorization', () =>
    Effect.gen(function* retainDefaultModuleAccess() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['privacy.core'] });
      const modules = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship?.resource?.objectType === 'module_access' ? [update.relationship] : [],
      );
      expect(modules).toHaveLength(3);
      expect(new Set(modules?.map(({ resource }) => resource?.objectId))).toEqual(
        new Set([toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry')]),
      );
      yield* fixture.close();
    }),
  );

  suite.effect(
    'configured module access rejects missing, empty, duplicate and malformed modules before provisioning',
    () =>
      Effect.gen(function* rejectInvalidConfiguredModules() {
        const inputs = [
          { ...configuration, moduleAccess: 'configured-modules' as const },
          ...[[], ['privacy.core', 'privacy.core'], [''], ['x'.repeat(1024)]].map((moduleKeys) => ({
            ...configuration,
            moduleAccess: 'configured-modules' as const,
            moduleKeys,
          })),
        ];
        for (const input of inputs) {
          const beforeInsert = transport.insert.mock.calls.length;
          const beforeWrite = transport.writeRelationships.mock.calls.length;
          const failure = yield* Effect.flip(makeLiveOperationFixture(input));
          expect(failure.reason).toBe('Invalid live operation fixture configuration');
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        }
      }),
  );

  suite.effect('rejects unsupported module access modes before provisioning', () =>
    Effect.gen(function* rejectUnknownModuleAccessMode() {
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Runtime callers cannot enable arbitrary module authorization modes.
          moduleAccess: 'all-modules',
          moduleKeys: ['privacy.core'],
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
    }),
  );

  suite.effect('creates exactly one opt-in same-Tenant Legal Entity for the existing manager identity', () =>
    Effect.gen(function* createSecondaryLegalEntity() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        additionalLegalEntity: 'same-tenant',
      });
      const inserts = transport.insert.mock.calls.slice(beforeInsert);
      const entities = inserts.filter(([table]) => table === legalEntities);
      expect(entities).toHaveLength(2);
      assert(fixture.secondaryLegalEntity !== undefined);
      const secondary = fixture.secondaryLegalEntity;
      expect(secondary.legalEntityId).not.toBe(fixture.legalEntityId);
      expect(secondary.manager).toEqual({ ...fixture.manager, legalEntityId: secondary.legalEntityId });
      expect(entities[1]?.[1]).toMatchObject({
        legalEntityId: secondary.legalEntityId,
        status: 'active',
        tenantId: fixture.tenantId,
      });
      expect(inserts.filter(([table]) => table === principals)).toHaveLength(1);
      expect(inserts.filter(([table]) => table === principalAuthBindings)).toHaveLength(1);
      const relations = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      const entityObject = toLegalEntityAccessObjectId(fixture.tenantId, secondary.legalEntityId);
      const moduleObject = toModuleAccessObjectId(fixture.tenantId, secondary.legalEntityId, 'party.registry');
      const secondaryRelations = relations?.filter(
        ({ resource }) => resource?.objectId === entityObject || resource?.objectId === moduleObject,
      );
      expect(secondaryRelations).toHaveLength(6);
      expect(
        secondaryRelations?.filter(
          ({ relation, resource }) => resource?.objectId === entityObject && relation === 'tenant',
        ),
      ).toMatchObject([{ subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } } }]);
      expect(
        secondaryRelations
          ?.filter(({ subject }) => subject?.object?.objectType === 'principal')
          .map(({ subject }) => subject?.object?.objectId),
      ).toEqual(Array.from({ length: 4 }, () => fixture.manager.principalId));
      expect(
        secondaryRelations
          ?.filter(({ relation, resource }) => resource?.objectId === entityObject && relation !== 'tenant')
          .map(({ relation }) => relation),
      ).toEqual(['member', 'counterparty_manager', 'counterparty_reader']);
      const actions = relations?.filter(({ resource }) => resource?.objectType === 'action');
      expect(actions).toEqual(
        buildExplicitActionGrantRelationships(
          configuration.actionKeys.map((actionKey) => ({ actionKey, principalIds: [fixture.manager.principalId] })),
        ),
      );
      yield* fixture.close();
    }),
  );

  suite.effect('default provisioning retains one Legal Entity and no secondary context', () =>
    Effect.gen(function* retainSingleLegalEntity() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const before = transport.insert.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture(configuration);
      expect(transport.insert.mock.calls.slice(before).filter(([table]) => table === legalEntities)).toHaveLength(1);
      expect(fixture.secondaryLegalEntity).toBeUndefined();
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unsupported additional Legal Entity modes before identity provisioning', () =>
    Effect.gen(function* rejectUnboundedLegalEntityMode() {
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Invalid runtime callers cannot request arbitrary Legal Entity creation.
          additionalLegalEntity: 'arbitrary',
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
    }),
  );

  suite.effect('provisions only its generated manager for explicit Action execution', () =>
    Effect.gen(function* provisionManagerActions() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const before = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({ ...configuration, actionExecutor: 'manager-only' });
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 1);
      const actions = transport.writeRelationships.mock.calls[before]?.[0].updates.flatMap((update) =>
        update.relationship?.resource?.objectType === 'action' ? [update.relationship] : [],
      );
      expect(actions).toEqual(
        buildExplicitActionGrantRelationships(
          configuration.actionKeys.map((actionKey) => ({
            actionKey,
            principalIds: [fixture.manager.principalId],
          })),
        ),
      );
      expect(actions).toHaveLength(configuration.actionKeys.length);
      for (const action of actions ?? []) {
        expect(action.subject?.object?.objectType).toBe('principal');
        expect(action.subject?.optionalRelation).toBe('');
        expect(action.subject?.object?.objectId).not.toBe(fixture.denied.principalId);
        expect(action.subject?.object?.objectId).not.toBe(fixture.reader.principalId);
        expect(action.subject?.object?.objectId).not.toBe(fixture.legalEntityOnly.principalId);
      }
    }),
  );

  suite.effect('binds the reader provider identity and grants only its selected Action without extra access', () =>
    Effect.gen(function* grantSelectedReaderAction() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const selectedKey = 'commerce.catalog.activate-local-override';
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        managerProviderSubjectId: 'manager-user-1',
        moduleAccess: 'configured-modules',
        moduleKeys: ['commerce.catalog', 'privacy.core'],
        readerActionKeys: [selectedKey],
        readerProviderSubjectId: 'reader-user-2',
      });
      const bindings = transport.insert.mock.calls
        .slice(beforeInsert)
        .filter(([table]) => table === principalAuthBindings)
        .flatMap(([, rows]) => (Array.isArray(rows) ? rows : [rows]));
      expect(bindings).toMatchObject([
        { principalId: fixture.manager.principalId, providerSubjectId: 'manager-user-1' },
        { principalId: fixture.legalEntityOnly.principalId, providerSubjectId: fixture.legalEntityOnly.authBindingId },
        { principalId: fixture.denied.principalId, providerSubjectId: fixture.denied.authBindingId },
        { principalId: fixture.reader.principalId, providerSubjectId: 'reader-user-2' },
      ]);
      const relations = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      expect(relations?.filter((item) => item.subject?.object?.objectId === fixture.reader.principalId)).toEqual([
        ...['member', 'party_identity_reader'].map((relation) =>
          v1.Relationship.create({
            relation,
            resource: { objectId: fixture.tenantId, objectType: 'tenant' },
            subject: { object: { objectId: fixture.reader.principalId, objectType: 'principal' } },
          }),
        ),
        ...buildExplicitActionGrantRelationships([
          { actionKey: selectedKey, principalIds: [fixture.reader.principalId] },
        ]),
      ]);
      expect(relations?.filter((item) => item.resource?.objectType === 'action')).toEqual([
        ...buildExplicitActionGrantRelationships(
          configuration.actionKeys.map((actionKey) => ({
            actionKey,
            principalIds: [fixture.manager.principalId],
          })),
        ),
        ...buildExplicitActionGrantRelationships([
          { actionKey: selectedKey, principalIds: [fixture.reader.principalId] },
        ]),
      ]);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unbounded reader Action selection and malformed provider identities before provisioning', () =>
    Effect.gen(function* refuseInvalidReaderOptions() {
      const selectedKey = 'commerce.catalog.activate-local-override';
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      for (const options of [
        { readerActionKeys: [selectedKey] },
        { readerActionKeys: [] },
        { actionExecutor: 'tenant-membership', readerActionKeys: [selectedKey] },
        { actionExecutor: 'manager-only', readerActionKeys: [selectedKey, selectedKey] },
        { actionExecutor: 'manager-only', readerActionKeys: ['core.identity.bind-self-api-key'] },
        { actionExecutor: 'manager-only', actionKeys: [], readerActionKeys: [selectedKey] },
        {
          actionExecutor: 'manager-only',
          actionKeys: ['commerce.catalog.*'],
          readerActionKeys: ['commerce.catalog.*'],
        },
        { actionExecutor: 'manager-only', actionKeys: [''], readerActionKeys: [''] },
        { actionExecutor: 'manager-only', actionKeys: ['not an action'], readerActionKeys: ['not an action'] },
        { readerProviderSubjectId: '' },
        { readerProviderSubjectId: 'x'.repeat(501) },
      ] as const) {
        const failure = yield* Effect.flip(makeLiveOperationFixture({ ...configuration, ...options }));
        expect(failure.reason).toBe('Invalid live operation fixture configuration');
      }
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
    }),
  );

  suite.effect('keeps default and explicit tenant-membership provisioning unchanged', () =>
    Effect.gen(function* provisionDefaultActions() {
      for (const input of [configuration, { ...configuration, actionExecutor: 'tenant-membership' as const }]) {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const before = transport.writeRelationships.mock.calls.length;
        const fixture = yield* makeLiveOperationFixture(input);
        yield* fixture.close();
        const actions = transport.writeRelationships.mock.calls[before]?.[0].updates.flatMap((update) =>
          update.relationship?.resource?.objectType === 'action' ? [update.relationship] : [],
        );
        expect(actions).toEqual(
          buildActionAuthorizationRelationships(configuration.actionKeys, [
            { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
          ]),
        );
      }
    }),
  );

  suite.effect('grants and verifies only the explicit named permission for the exact fixture actor and scope', () =>
    Effect.gen(function* grantExactContextPermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const objectId = toContextPermissionAccessObjectId(fixture.tenantId, fixture.legalEntityId, target);
      assert(objectId !== undefined);
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      expect(
        transport.writeRelationships.mock.lastCall?.[0].updates.some(
          (update) => update.relationship?.resource?.objectType === 'context_permission',
        ),
      ).toBe(false);
      yield* fixture.grantContextPermissionAccess(target, fixture.manager.principalId);
      expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual([
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'tenant',
            resource: { objectId, objectType: 'context_permission' },
            subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } },
          }),
        }),
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'grantee',
            resource: { objectId, objectType: 'context_permission' },
            subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
          }),
        }),
      ]);
      expect(transport.checkPermission.mock.lastCall?.[0]).toMatchObject({
        consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
        permission: 'access',
        resource: { objectId, objectType: 'context_permission' },
        subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
      });
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck + 1);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects foreign actors, unconfigured modules and supplied context scope before grant I/O', () =>
    Effect.gen(function* rejectUnboundedContextPermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const foreignId = '00000000-0000-4000-8000-000000000099';
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      for (const attempted of [
        { ...target, moduleId: 'commerce.unknown' },
        { ...target, moduleId: 'commerce.*' },
        { ...target, moduleId: '' },
        { ...target, permission: '*' },
        { ...target, permission: '' },
        { ...target, permission: 'market catalog read' },
        { ...target, tenantId: foreignId },
        { ...target, legalEntityId: foreignId },
        { ...target, principalId: fixture.reader.principalId },
      ]) {
        const failure = yield* Effect.flip(
          fixture.grantContextPermissionAccess(attempted, fixture.manager.principalId),
        );
        expect(failure.reason).toBe('Invalid live fixture context permission grant');
      }
      for (const principalId of [foreignId, '*', '']) {
        const failure = yield* Effect.flip(fixture.grantContextPermissionAccess(target, principalId));
        expect(failure.reason).toBe('Invalid live fixture context permission grant');
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
      yield* fixture.close();
    }),
  );

  suite.effect('preserves named permission write and verification failures without broader grants', () =>
    Effect.gen(function* failClosedContextPermissionGrant() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      transport.writeRelationships.mockRejectedValueOnce(new Error('unit-only context grant failure'));
      const writeFailure = yield* Effect.flip(
        fixture.grantContextPermissionAccess(target, fixture.manager.principalId),
      );
      expect(writeFailure.reason).toBe('Unable to grant live fixture context permission access');
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
      transport.checkPermission.mockResolvedValueOnce(permissionResponse(false));
      const denied = yield* Effect.flip(fixture.grantContextPermissionAccess(target, fixture.manager.principalId));
      expect(denied.reason).toBe('Live fixture authorization does not match its exact declared grants');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 2);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('revokes only the exact granted resource permission tuple for each principal and permission', () =>
    Effect.gen(function* revokeExactResourcePermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const resource = { moduleId: 'commerce.catalog', resourceId: 'owned-product', resourceType: 'product' };
      for (const principalId of [fixture.manager.principalId, fixture.reader.principalId]) {
        for (const permission of ['reader', 'writer'] as const) {
          const before = transport.writeRelationships.mock.calls.length;
          yield* fixture.grantResourceAccess(resource, principalId, permission);
          yield* fixture.revokeResourceAccess(resource, principalId, permission);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 2);
          const grant = transport.writeRelationships.mock.calls[before]?.[0];
          const revoke = transport.writeRelationships.mock.calls[before + 1]?.[0];
          expect(grant?.updates).toHaveLength(4);
          expect(grant?.updates.every((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(
            true,
          );
          const grantedPermission = grant?.updates[3]?.relationship;
          expect(grantedPermission).toMatchObject({
            relation: permission,
            resource: { objectType: 'resource' },
            subject: { object: { objectId: principalId } },
          });
          expect(revoke?.updates).toHaveLength(1);
          expect(revoke?.updates[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
          expect(revoke?.updates[0]?.relationship).toEqual(grantedPermission);
          expect(grant?.updates.slice(0, 3).map((update) => update.relationship?.relation)).toEqual([
            'legal_entity',
            'accessor',
            'module',
          ]);
        }
      }
      yield* fixture.close();
    }),
  );

  suite.effect('duplicate TOUCH grants are not reference counted and close does not automatically revoke tuples', () =>
    Effect.gen(function* retainExplicitGrantOwnership() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const resource = { moduleId: 'commerce.catalog', resourceId: 'fresh-product', resourceType: 'product' };
      const before = transport.writeRelationships.mock.calls.length;
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      expect(transport.writeRelationships.mock.calls[before]?.[0]).toEqual(
        transport.writeRelationships.mock.calls[before + 1]?.[0],
      );
      yield* fixture.revokeResourceAccess(resource, fixture.manager.principalId);
      const updates = transport.writeRelationships.mock.calls[before + 2]?.[0].updates;
      expect(updates).toHaveLength(1);
      expect(updates?.[0]?.relationship?.relation).toBe('reader');
      expect(updates?.[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 3);
    }),
  );

  suite.effect('resource revocation preserves invalid-target and external-write failures as typed errors', () =>
    Effect.gen(function* rejectInvalidResourceRevocation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const before = transport.writeRelationships.mock.calls.length;
      for (const resource of [
        { moduleId: '', resourceId: 'product', resourceType: 'product' },
        { moduleId: 'commerce.catalog', resourceId: '', resourceType: 'product' },
        { moduleId: 'commerce.catalog', resourceId: 'product', resourceType: '' },
        { moduleId: 'commerce.catalog', resourceId: 'x'.repeat(1024), resourceType: 'product' },
      ]) {
        for (const operation of [fixture.grantResourceAccess, fixture.revokeResourceAccess]) {
          const failure = yield* Effect.flip(operation(resource, fixture.manager.principalId));
          expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
          expect(failure.reason).toBe('Invalid resource fixture');
        }
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
      const cause = new Error('unit-only transport unavailable');
      transport.writeRelationships.mockRejectedValueOnce(cause);
      const failure = yield* Effect.flip(
        fixture.revokeResourceAccess(
          { moduleId: 'commerce.catalog', resourceId: 'owned-product', resourceType: 'product' },
          fixture.manager.principalId,
        ),
      );
      expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
      expect(failure.reason).toBe('Unable to revoke live fixture resource access');
      expect(failure.cause).toBe(cause);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unknown executor modes before provisioning', () =>
    Effect.gen(function* rejectUnknownExecutor() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const before = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Foreign callers can still supply an unsupported executor mode at runtime.
          actionExecutor: 'everybody',
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
    }),
  );

  suite.effect(
    'live fixture rejects missing and malformed release pins before reading configuration or opening services',
    () =>
      Effect.gen(function* rejectInvalidFixtureRelease() {
        for (const compositionRevision of ['', 'latest', 'a'.repeat(63), 'A'.repeat(64)]) {
          const failure = yield* Effect.flip(
            makeLiveOperationFixture({
              authenticationNamespaceId: 'fixture-release-unit',
              compositionRevision,
              runtimeConnectionString: Redacted.make('postgresql://unit:unit@127.0.0.1/unit'),
            }),
          );
          expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
          expect(failure.reason).toBe('Invalid live operation fixture configuration');
        }
      }),
  );
});

const attachmentDatabase = `ontos_test_party_gateway_${'a'.repeat(32)}`;
const attachmentConfiguration = {
  ...configuration,
  adminConnectionString: Redacted.make(`postgresql://unit_admin:unit@127.0.0.1/${attachmentDatabase}`),
  runtimeConnectionString: Redacted.make(`postgresql://unit:unit@127.0.0.1/${attachmentDatabase}`),
};
const safeNative = {
  bypass: false,
  createDb: false,
  createRole: false,
  database: attachmentDatabase,
  role: 'unit',
  session: 'unit',
  superuser: false,
};
const prepareAttachment = Effect.gen(function* prepareAttachment() {
  transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
  const before = transport.insert.mock.calls.length;
  const creator = yield* makeLiveOperationFixture({
    ...attachmentConfiguration,
    actionExecutor: 'manager-only',
    managerProviderSubjectId: 'user-1',
    readerActionKeys: ['commerce.catalog.activate-local-override'],
    readerProviderSubjectId: 'user-2',
  });
  const seeded = transport.insert.mock.calls.slice(before);
  transport.nativeRows.mockReturnValue([safeNative]);
  transport.selectRows.mockImplementation((table) =>
    seeded.flatMap(([insertedTable, rows]) => {
      if (insertedTable !== table) {
        return [];
      }
      return Array.isArray(rows) ? rows : [rows];
    }),
  );
  return { creator, seeded };
});

const foreignFixtureIdentity = '00000000-0000-4000-8000-000000000099';
const faultedFixtureRows =
  (
    seeded: readonly (readonly [FixtureInsertTable, FixtureInsertValues])[],
    refusedTable: FixtureReadTable,
    fault: 'missing' | 'inactive' | 'mismatched',
  ) =>
  (table: FixtureReadTable) =>
    seeded.flatMap(([insertedTable, rows]) => {
      if (insertedTable !== table) {
        return [];
      }
      const values = Array.isArray(rows) ? rows : [rows];
      if (table !== refusedTable) {
        return values;
      }
      if (fault === 'missing') {
        return [];
      }
      return values.map((row) =>
        fault === 'inactive'
          ? { ...row, state: 'inactive', status: 'suspended' }
          : {
              ...row,
              legalEntityId: foreignFixtureIdentity,
              moduleKey: 'foreign.module',
              principalAuthBindingId: foreignFixtureIdentity,
              principalId: foreignFixtureIdentity,
              tenantId: foreignFixtureIdentity,
            },
      );
    });

it.layer(Layer.mergeAll(NodeCrypto.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({}))))(
  'runtime-only live fixture attachment',
  (suite) => {
    suite.effect('attaches with no admin configuration and performs no identity or grant writes', () =>
      Effect.gen(function* runtimeWithoutAdmin() {
        const { creator } = yield* prepareAttachment;
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const runtime = yield* makeLiveOperationFixtureRuntime({
          configuration: creator.runtimeHandoff.configuration,
          handoff: creator.runtimeHandoff,
          runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
        });
        expect(runtime.manager).toEqual(creator.manager);
        expect(runtime.tenantId).toBe(creator.tenantId);
        expect(runtime.legalEntityId).toBe(creator.legalEntityId);
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
          creator.runtimeHandoff,
        );
        expect(encoded).not.toContain('postgresql:');
        expect(encoded).not.toContain('connectionString');
        expect(encoded).not.toContain('executor');
        yield* runtime.close();
        yield* creator.close();
      }),
    );

    suite.effect(
      'runtime-only attachment rejects module-state administration without a mutation or admin capability',
      () =>
        Effect.gen(function* rejectAttachedModuleStateMutation() {
          const { creator } = yield* prepareAttachment;
          const runtime = yield* makeLiveOperationFixtureRuntime({
            configuration: creator.runtimeHandoff.configuration,
            handoff: creator.runtimeHandoff,
            runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
          });
          const beforeUpdate = transport.updateRows.mock.calls.length;
          const beforeInsert = transport.insert.mock.calls.length;
          const failure = yield* Effect.flip(runtime.setConfiguredModuleState('party.registry', 'suspended'));
          expect(failure.reason).toBe('Configured module state mutation requires the fixture creator');
          expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate);
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
            runtime.runtimeHandoff,
          );
          expect(encoded).not.toContain('adminConnectionString');
          yield* runtime.close();
          yield* creator.close();
        }),
    );

    suite.effect('refuses foreign targets, configuration drift and unsafe native roles before setup capabilities', () =>
      Effect.gen(function* refuseUnsafeAttachment() {
        const { creator } = yield* prepareAttachment;
        const original = creator.runtimeHandoff;
        const inputs = [
          { ...original, target: { ...original.target, database: 'foreign' } },
          { ...original, configuration: { ...original.configuration, compositionRevision: 'b'.repeat(64) } },
          { ...original, configuration: { ...original.configuration, managerProviderSubjectId: 'other-user' } },
          { ...original, configuration: { ...original.configuration, readerProviderSubjectId: 'other-reader' } },
          { ...original, configuration: { ...original.configuration, readerActionKeys: [] } },
          { ...original, manager: { ...original.manager, tenantId: '00000000-0000-4000-8000-000000000001' } },
        ];
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const handoff of inputs) {
          const result = yield* Effect.result(
            makeLiveOperationFixtureRuntime({
              configuration: original.configuration,
              handoff,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
        }
        for (const native of [
          { ...safeNative, superuser: true },
          { ...safeNative, bypass: true },
          { ...safeNative, createDb: true },
          { ...safeNative, createRole: true },
          { ...safeNative, database: 'foreign' },
          { ...safeNative, session: 'administrator' },
        ]) {
          transport.nativeRows.mockReturnValue([native]);
          const result = yield* Effect.result(
            makeLiveOperationFixtureRuntime({
              configuration: original.configuration,
              handoff: original,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
        }
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* creator.close();
      }),
    );

    suite.effect(
      'rejects persisted reader subject substitution and invalid reader handoff selection without writes',
      () =>
        Effect.gen(function* refuseReaderIdentitySubstitution() {
          const { creator, seeded } = yield* prepareAttachment;
          const beforeInsert = transport.insert.mock.calls.length;
          const beforeWrite = transport.writeRelationships.mock.calls.length;
          const malformed = yield* Effect.result(
            Schema.decodeUnknownEffect(LiveOperationFixtureRuntimeHandoffSchema)({
              ...creator.runtimeHandoff,
              configuration: {
                ...creator.runtimeHandoff.configuration,
                readerActionKeys: ['core.identity.unselected'],
              },
            }),
          );
          expect(Result.isFailure(malformed)).toBe(true);
          transport.selectRows.mockImplementation((table) => {
            const selected: FixtureReadRow[] = [];
            for (const [insertedTable, rows] of seeded) {
              if (insertedTable !== table) {
                continue;
              }
              for (const row of Array.isArray(rows) ? rows : [rows]) {
                selected.push(
                  table === principalAuthBindings &&
                    'principalId' in row &&
                    row.principalId === creator.reader.principalId
                    ? { ...row, providerSubjectId: 'substituted-reader' }
                    : row,
                );
              }
            }
            return selected;
          });
          const failure = yield* Effect.flip(
            makeLiveOperationFixtureRuntime({
              configuration: creator.runtimeHandoff.configuration,
              handoff: creator.runtimeHandoff,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          assert(Predicate.isTagged(failure, 'LiveOperationFixtureError'));
          expect(failure.reason).toBe('Runtime fixture identities are not the active persisted creator state');
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
          yield* creator.close();
        }),
    );

    suite.effect('refuses inactive, contradictory or missing persisted creator identities', () =>
      Effect.gen(function* refuseMissingCreatorState() {
        const { creator, seeded } = yield* prepareAttachment;
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const refusedTable of [tenants, legalEntities, principals, principalAuthBindings, tenantModuleStates]) {
          for (const fault of ['missing', 'inactive', 'mismatched'] as const) {
            transport.selectRows.mockImplementation(faultedFixtureRows(seeded, refusedTable, fault));
            const result = yield* Effect.result(
              makeLiveOperationFixtureRuntime({
                configuration: creator.runtimeHandoff.configuration,
                handoff: creator.runtimeHandoff,
                runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
              }),
            );
            expect(Result.isFailure(result)).toBe(true);
          }
        }
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* creator.close();
      }),
    );

    suite.effect(
      'accepts one closed bootstrap request and rejects malformed or repeated requests without another seed',
      () =>
        Effect.gen(function* oneShotBootstrap() {
          const { creator } = yield* prepareAttachment;
          let calls = 0;
          const bootstrap = yield* makeLiveOperationFixtureBootstrap(() =>
            Effect.sync(() => {
              calls += 1;
              return creator.runtimeHandoff;
            }),
          );
          for (const request of [
            { sql: 'forbidden', type: 'execute-sql' },
            { type: 'auth-user-created' },
            { adminConnectionString: 'forbidden', providerSubjectId: 'user-1', type: 'auth-user-created' },
          ]) {
            expect(
              Result.isFailure(
                yield* Effect.result(
                  Schema.decodeUnknownEffect(LiveOperationFixtureBootstrapRequestSchema, { onExcessProperty: 'error' })(
                    request,
                  ),
                ),
              ),
            ).toBe(true);
          }
          expect(calls).toBe(0);
          expect((yield* bootstrap({ providerSubjectId: 'user-1', type: 'auth-user-created' })).handoff).toEqual(
            creator.runtimeHandoff,
          );
          expect(
            Result.isFailure(
              yield* Effect.result(bootstrap({ providerSubjectId: 'user-2', type: 'auth-user-created' })),
            ),
          ).toBe(true);
          expect(calls).toBe(1);
          const mismatched = yield* makeLiveOperationFixtureBootstrap(() => Effect.succeed(creator.runtimeHandoff));
          expect(
            Result.isFailure(
              yield* Effect.result(mismatched({ providerSubjectId: 'other-user', type: 'auth-user-created' })),
            ),
          ).toBe(true);
          yield* creator.close();
        }),
    );
  },
);
