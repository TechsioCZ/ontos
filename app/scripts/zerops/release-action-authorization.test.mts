import { readFileSync } from 'node:fs';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Exit, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActionAuthorizationProvisioningAction } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { SpiceDbRpcError } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import {
  deriveReleaseActionAuthorization,
  loadReleaseActionAuthorizationConfiguration,
  recordReleaseActionAuthorization,
  RELEASE_ACTION_AUTHORIZATION_STATUS_FILE,
  touchMissingActionAuthorization,
} from './release-action-authorization.mts';

const ACTIVE_TENANT = '11111111-1111-4111-8111-111111111111';
const SUSPENDED_TENANT = '22222222-2222-4222-8222-222222222222';
const ACTIVE_COMPANY = '33333333-3333-4333-8333-333333333333';
const ARCHIVED_COMPANY = '44444444-4444-4444-8444-444444444444';
const SUSPENDED_TENANT_COMPANY = '55555555-5555-4555-8555-555555555555';
const coreModule = coreActionCatalog[0]?.owningModuleKey ?? 'core.identity';

const actions: readonly ActionAuthorizationProvisioningAction[] = [
  {
    actionKey: 'core.identity.bind-self-api-key',
    legalEntityScope: 'forbidden',
    owningModuleKey: 'core.identity',
    provisioning: 'principal_self_credentials',
  },
  {
    actionKey: 'core.people.list',
    legalEntityScope: 'required',
    owningModuleKey: coreModule,
    provisioning: 'explicit',
  },
  { actionKey: 'crm.update', legalEntityScope: 'required', owningModuleKey: 'crm', provisioning: 'explicit' },
  { actionKey: 'rental.book', legalEntityScope: 'required', owningModuleKey: 'rental', provisioning: 'explicit' },
];
const inventory = {
  companies: [
    { legalEntityId: ACTIVE_COMPANY, status: 'active', tenantId: ACTIVE_TENANT },
    { legalEntityId: ARCHIVED_COMPANY, status: 'archived', tenantId: ACTIVE_TENANT },
    { legalEntityId: SUSPENDED_TENANT_COMPANY, status: 'active', tenantId: SUSPENDED_TENANT },
  ],
  moduleStates: [
    { moduleKey: 'crm', state: 'active', tenantId: ACTIVE_TENANT },
    { moduleKey: 'rental', state: 'uninstalled', tenantId: ACTIVE_TENANT },
    { moduleKey: 'crm', state: 'active', tenantId: SUSPENDED_TENANT },
  ],
  tenants: [
    { status: 'active', tenantId: ACTIVE_TENANT },
    { status: 'suspended', tenantId: SUSPENDED_TENANT },
  ],
};

const describe = (relationship: v1.Relationship) =>
  `${relationship.relation}->${relationship.subject?.object?.objectType ?? ''}`;

it.effect('derives Core and installed-module edges for active Tenants and active companies only', () =>
  Effect.gen(function* derivesActiveScopes() {
    const derived = yield* deriveReleaseActionAuthorization(actions, ['crm', 'rental'], inventory);
    expect(derived.tenants).toBe(1);
    expect(derived.companies).toBe(2);
    const serialized = derived.relationships.map((relationship) => v1.Relationship.toJsonString(relationship));
    expect(serialized.some((text) => text.includes(SUSPENDED_TENANT))).toBe(false);
    // Two company Actions (Core people and installed CRM) in the active company, scope plus grant link each.
    expect(derived.relationships.filter(({ relation }) => relation === 'company_scope')).toHaveLength(2);
    expect(derived.relationships.filter(({ relation }) => relation === 'grant')).toHaveLength(3);
    // The uninstalled module and the archived company get nothing; the own-key Action gets its intrinsic edge.
    const companyScope = 'company_scope->legal_entity';
    const grantLink = 'grant->action_grant';
    expect(derived.relationships.map(describe).toSorted()).toEqual(
      [
        companyScope,
        companyScope,
        grantLink,
        grantLink,
        grantLink,
        'self_credentials->tenant',
        'tenant_scope->tenant',
      ].toSorted(),
    );
  }),
);

it.effect('an unpublished module adds no edges even when the Tenant marks it active', () =>
  Effect.gen(function* unpublished() {
    const derived = yield* deriveReleaseActionAuthorization(actions, [], inventory);
    expect(derived.relationships.filter(({ relation }) => relation === 'company_scope')).toHaveLength(1);
  }),
);

const fakeRpc = (existing: readonly v1.Relationship[]) => {
  const writes: v1.WriteRelationshipsRequest[] = [];
  const rpc: Pick<SpiceDbRpc, 'readRelationships' | 'writeRelationships'> = {
    readRelationships: () =>
      Effect.succeed(existing.map((relationship) => v1.ReadRelationshipsResponse.create({ relationship }))),
    writeRelationships: (request) =>
      Effect.sync(() => {
        writes.push(request);
        return v1.WriteRelationshipsResponse.create({});
      }),
  };
  return { rpc, writes };
};

it.effect('touches only missing edges and never deletes a present edge, desired or not', () =>
  Effect.gen(function* touchOnly() {
    const { relationships } = yield* deriveReleaseActionAuthorization(actions, ['crm'], inventory);
    const foreign = v1.Relationship.create({
      relation: 'company_scope',
      resource: { objectId: 'ak_owned-by-a-per-tenant-script', objectType: 'action' },
      subject: { object: { objectId: 'company', objectType: 'legal_entity' } },
    });
    const [present, ...missing] = relationships;
    const { rpc, writes } = fakeRpc(present === undefined ? [foreign] : [present, foreign]);
    const touched = yield* touchMissingActionAuthorization(rpc, relationships);
    expect(touched).toBe(missing.length);
    const written = writes.flatMap(({ updates }) => updates);
    expect(written).toHaveLength(missing.length);
    expect(written.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
    // A rerun against the converged graph writes nothing.
    const rerun = fakeRpc(relationships);
    expect(yield* touchMissingActionAuthorization(rerun.rpc, relationships)).toBe(0);
    expect(rerun.writes).toHaveLength(0);
  }),
);

it.effect('writes in batches SpiceDB accepts', () =>
  Effect.gen(function* batches() {
    const desired = Array.from({ length: 1201 }, (_, index) =>
      v1.Relationship.create({
        relation: 'tenant_scope',
        resource: { objectId: `ak_${String(index)}`, objectType: 'action' },
        subject: { object: { objectId: ACTIVE_TENANT, objectType: 'tenant' } },
      }),
    );
    const { rpc, writes } = fakeRpc([]);
    expect(yield* touchMissingActionAuthorization(rpc, desired)).toBe(1201);
    expect(writes.map(({ updates }) => updates.length)).toEqual([500, 500, 201]);
  }),
);

it.effect('a SpiceDB write failure fails the step with a sanitized reason', () =>
  Effect.gen(function* writeFailure() {
    const { relationships } = yield* deriveReleaseActionAuthorization(actions, ['crm'], inventory);
    const exit = yield* Effect.exit(
      touchMissingActionAuthorization(
        {
          readRelationships: () => Effect.succeed([]),
          writeRelationships: () => Effect.fail(new SpiceDbRpcError({ cause: 'secret detail', code: Option.none() })),
        },
        relationships,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('Missing Action edges could not be written');
    expect(JSON.stringify(exit)).not.toContain('secret detail');
  }),
);

const refusal = (environment: Record<string, string>) =>
  loadReleaseActionAuthorizationConfiguration(ConfigProvider.fromUnknown(environment)).pipe(
    Effect.exit,
    Effect.map((exit) => JSON.stringify(exit)),
  );
const stageSpiceDb = {
  SPICEDB_CA_CERT: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
  SPICEDB_ENDPOINT: 'spicedb:50051',
  SPICEDB_PRESHARED_KEY: 'withheld-key',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};

it.effect('refuses outside stage and against any SpiceDB other than the fixed stage endpoint', () =>
  Effect.gen(function* refusesTargets() {
    const accepted = yield* loadReleaseActionAuthorizationConfiguration(ConfigProvider.fromUnknown(stageSpiceDb));
    expect(accepted.endpoint).toBe('spicedb:50051');
    const message = 'runs only on stage against the fixed stage SpiceDB';
    expect(yield* refusal({ ...stageSpiceDb, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' })).toContain(message);
    expect(yield* refusal({ ...stageSpiceDb, SPICEDB_ENDPOINT: 'spicedb.example:443' })).toContain(message);
    expect(yield* refusal({ ...stageSpiceDb, SPICEDB_ENDPOINT: 'spicedb.example:443' })).not.toContain('withheld-key');
  }),
);

it('app-host provisions the release before publishing it and does not ignore a failure', () => {
  const host = readFileSync(new URL('app-host.mts', import.meta.url), 'utf-8');
  const provision = host.indexOf('yield* provisionActionAuthorization(releaseSnapshot)');
  const publish = host.indexOf('yield* publishSnapshot(releaseSnapshot)');
  const openPort = host.indexOf('yield* openPublicPort;\n    yield* Ref.set(published, true);\n    yield* closePublic');
  expect(provision).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(provision);
  expect(openPort).toBeGreaterThan(publish);
  const step = host.slice(host.indexOf('const provisionActionAuthorization'), provision);
  expect(step).not.toContain('Effect.ignore');
  const source = readFileSync(new URL('release-action-authorization.mts', import.meta.url), 'utf-8');
  expect(source).not.toContain('RelationshipUpdate_Operation.DELETE');
});

it.effect('records the result as a readable status file under the workspace', () =>
  Effect.gen(function* recordsStatus() {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped();
    yield* recordReleaseActionAuthorization(workspace, {
      companies: 9,
      desired: 2660,
      finishedAt: DateTime.makeUnsafe('2026-11-05T12:00:00Z'),
      outcome: 'applied',
      revision: 'r1',
      revoked: 0,
      tenants: 5,
      touched: 8,
    });
    const text = yield* fs.readFileString(`${workspace}/${RELEASE_ACTION_AUTHORIZATION_STATUS_FILE}`);
    expect(JSON.parse(text)).toEqual({
      companies: 9,
      desired: 2660,
      finishedAt: '2026-11-05T12:00:00.000Z',
      outcome: 'applied',
      revision: 'r1',
      revoked: 0,
      tenants: 5,
      touched: 8,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
