import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { makeModuleContractFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import type { deriveOntosModuleDeploymentContract } from '../generate-ontos-module-contract.mts';
import {
  LOCAL_DEVELOPMENT_VERTICALS,
  LOCAL_DEVELOPMENT_CONTEXT,
  LocalDevelopmentInitializationError,
  buildLocalDevelopmentRelationships,
  classifyExactLocalRecord,
  classifyLocalModuleState,
  deriveActivatedModuleIds,
  moduleStateIdFor,
  parseLocalDevelopmentConfiguration,
  reconcileCoreContext,
} from '../initialize-local-development.mts';
import {
  CZECH_LAUNCH_COMMERCE_FIXTURE,
  CzechLaunchActivationRejected,
  validateCzechLaunchActivation,
  validateCzechLaunchFixtureContracts,
} from '../czech-launch-commerce-fixture.mts';

const localEnvironment = {
  BETTER_AUTH_SECRET: 'a-local-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_ADMIN_URL: 'postgres://ontos_admin:admin@localhost:5432/ontos',
  DATABASE_URL: 'postgres://ontos_runtime:runtime@localhost:5432/ontos',
  SPICEDB_ENDPOINT: 'localhost:50051',
  SPICEDB_INSECURE: 'true',
  SPICEDB_PRESHARED_KEY: 'local-spicedb-key',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
} as const;

const LOCAL_AUTH_USER_ID = 'local-auth-user';
const INVENTORY_MODULE_ID = 'inventory.core';
const LOCAL_MODULES_DIRECTORY_PREFIX = 'ontos-local-modules-';
const CUSTOMER_CONTEXT_VERTICAL_ID = 'commerce-customer-context';
const MARKET_CATALOG_VERTICAL_ID = 'commerce-market-catalog';
const PARTY_REGISTRY_VERTICAL_ID = 'party-registry';
const PARTY_REGISTRY_MODULE_ID = 'party.registry';
const PARTY_REGISTRY_MODULE_STATE_LABEL = 'Party Registry module state';
const CATALOG_MODULE_ID = 'commerce.catalog';
const TOPOLOGY_DIRECTORY = 'topology';
const TOPOLOGY_PATH = 'topology/reference-topology.json';
const topology = JSON.stringify({
  verticals: [
    { id: PARTY_REGISTRY_VERTICAL_ID },
    { id: MARKET_CATALOG_VERTICAL_ID },
    { id: CUSTOMER_CONTEXT_VERTICAL_ID },
    { id: 'inventory' },
  ],
});

const moduleContract = (moduleId: string): Effect.Success<ReturnType<typeof deriveOntosModuleDeploymentContract>> =>
  makeModuleContractFixture({
    appId: 'test-module',
    buildMarker: 'test-build',
    moduleId,
  });

it.effect('accepts only a development configuration with local service endpoints', () =>
  Effect.gen(function* testEffect1() {
    const configuration = yield* parseLocalDevelopmentConfiguration(localEnvironment);
    expect(configuration.email).toBe(LOCAL_DEVELOPMENT_CONTEXT.email);
    expect(configuration.databaseAdminUrl).toBe(localEnvironment.DATABASE_ADMIN_URL);

    yield* Effect.all(
      [
        { ...localEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' },
        {
          ...localEnvironment,
          DATABASE_ADMIN_URL: 'postgres://ontos_admin:admin@database.example.com:5432/ontos',
        },
        {
          ...localEnvironment,
          SPICEDB_ENDPOINT: 'spicedb.example.com:50051',
          SPICEDB_INSECURE: 'false',
        },
      ].map((environment) =>
        Effect.gen(function* testEffect2() {
          expect(
            Schema.is(LocalDevelopmentInitializationError)(
              yield* Effect.flip(parseLocalDevelopmentConfiguration(environment)),
            ),
          ).toBe(true);
        }),
      ),
    );
  }),
);

it.effect('exact reconciliation is idempotent and contradictory records fail in the typed channel', () =>
  Effect.gen(function* testEffect3() {
    const expected = {
      name: 'OntOS Local Development',
      status: 'active',
    } as const;
    expect(yield* classifyExactLocalRecord('tenant', undefined, expected)).toBe('create');
    expect(yield* classifyExactLocalRecord('tenant', expected, expected)).toBe('existing');
    const conflict = yield* classifyExactLocalRecord('tenant', { ...expected, status: 'suspended' }, expected).pipe(
      Effect.flip,
    );
    expect(conflict.code).toBe('local_conflict');
    expect(conflict.reason).toMatch(/status/u);
  }),
);

it.effect('module-state reconciliation preserves migrated IDs and rejects identity collisions', () =>
  Effect.gen(function* testEffect4() {
    const expected = {
      moduleKey: PARTY_REGISTRY_MODULE_ID,
      state: 'active',
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
      tenantModuleStateId: moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
    } as const;
    expect(yield* classifyLocalModuleState(PARTY_REGISTRY_MODULE_STATE_LABEL, undefined, expected)).toBe('create');
    expect(
      yield* classifyLocalModuleState(
        PARTY_REGISTRY_MODULE_STATE_LABEL,
        {
          ...expected,
          tenantModuleStateId: '7f000000-0000-4000-8000-000000000001',
        },
        expected,
      ),
    ).toBe('existing');
    expect(
      Schema.is(LocalDevelopmentInitializationError)(
        yield* Effect.flip(
          classifyLocalModuleState(
            PARTY_REGISTRY_MODULE_STATE_LABEL,
            {
              ...expected,
              moduleKey: INVENTORY_MODULE_ID,
              tenantModuleStateId: expected.tenantModuleStateId,
            },
            expected,
          ),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('derives the fixed local commerce launch modules through generated owner contracts', () =>
  Effect.gen(function* testEffect5() {
    const root = yield* Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX)));
    yield* Effect.tryPromise(() => mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true }));
    yield* Effect.tryPromise(() => writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8'));
    const deriveContract = ({ vertical }: { readonly vertical: string }) =>
      Effect.succeed(moduleContract(`${vertical}.core`));
    expect(yield* deriveActivatedModuleIds(root, deriveContract).pipe(Effect.provide(NodeServices.layer))).toEqual([
      'commerce-customer-context.core',
      'commerce-market-catalog.core',
      'party-registry.core',
    ]);
    expect(LOCAL_DEVELOPMENT_VERTICALS).toEqual([
      PARTY_REGISTRY_VERTICAL_ID,
      MARKET_CATALOG_VERTICAL_ID,
      CUSTOMER_CONTEXT_VERTICAL_ID,
    ]);
  }),
);

it('omits the excluded storefront from the default market tuple', () => {
  expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.marketBootstrap.revision.value).toEqual({
    defaultChannelId: 'B2C',
    defaultCommerceMarketId: '74000000-0000-4000-8000-000000000010',
    defaultSellingLegalEntityId: '71000000-0000-4000-8000-000000000010',
    kind: 'DEFAULT_MARKET_TUPLE',
  });
});

it.effect('publishes a schema-valid deterministic Czech Launch operator fixture', () =>
  Effect.gen(function* validateFixture() {
    yield* validateCzechLaunchFixtureContracts();
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.scope).toMatchObject({
      channelId: 'B2C',
      storefrontId: 'czech-launch-b2c',
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    });
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.quantity.revision.value).toEqual({
      basis: {
        targetDivisibilityRevision: 1,
        targetRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: '76000000-0000-4000-8000-000000000015',
          resourceType: 'commerce.catalog.package-definition',
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
        unitRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: '76000000-0000-4000-8000-000000000020',
          resourceType: 'commerce.catalog.product-unit',
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
        unitRuleRevision: 1,
      },
      constraintMode: 'REPLACEABLE_ENVELOPE',
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '1', multiple: '1' },
      kind: 'COMMERCE_QUANTITY_RULE',
      selector: {
        kind: 'PACKAGE_OPTION',
        packageOptionRef: {
          moduleId: 'commerce.catalog',
          resourceId: '76000000-0000-4000-8000-000000000015',
          resourceType: 'commerce.catalog.package-definition',
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
      },
    });
  }),
);

it.effect('fails Czech Launch activation closed without every current owner proof', () =>
  Effect.gen(function* validateActivation() {
    expect(
      yield* validateCzechLaunchActivation({
        ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts,
        paymentTermCatalog: {
          ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.paymentTermCatalog,
          current: [],
        },
      }).pipe(Effect.flip),
    ).toBeInstanceOf(CzechLaunchActivationRejected);
    const withUndeclaredEvidence = { ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts, undeclaredEvidence: true };
    expect(yield* validateCzechLaunchActivation(withUndeclaredEvidence).pipe(Effect.flip)).toBeInstanceOf(
      CzechLaunchActivationRejected,
    );

    expect(yield* validateCzechLaunchActivation(CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts)).toBeDefined();
  }),
);

it.effect('rejects duplicate module IDs derived from different verticals', () =>
  Effect.gen(function* testEffect6() {
    const root = yield* Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX)));
    yield* Effect.tryPromise(() => mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true }));
    yield* Effect.tryPromise(() => writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8'));
    const deriveContract = () => Effect.succeed(moduleContract('duplicate.core'));
    expect(
      Schema.is(LocalDevelopmentInitializationError)(
        yield* Effect.flip(
          deriveActivatedModuleIds(root, deriveContract, ['party-registry', 'inventory']).pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('generates stable module state IDs and complete access relationships', () =>
  Effect.gen(function* testEffect7() {
    expect(moduleStateIdFor(PARTY_REGISTRY_MODULE_ID)).toBe(moduleStateIdFor(PARTY_REGISTRY_MODULE_ID));
    expect(moduleStateIdFor(PARTY_REGISTRY_MODULE_ID)).not.toBe(moduleStateIdFor(INVENTORY_MODULE_ID));
    const relationships = yield* buildLocalDevelopmentRelationships([PARTY_REGISTRY_MODULE_ID, INVENTORY_MODULE_ID]);
    expect(relationships.length).toBe(7);
    expect(relationships.filter(({ relation }) => relation === 'accessor').length).toBe(2);
    expect(relationships.filter(({ relation }) => relation === 'legal_entity').length).toBe(2);
  }),
);

it.effect('a late module conflict rolls back Core bootstrap and retains its typed reason', () =>
  Effect.gen(function* testEffect8() {
    const statements: string[] = [];
    const database = yield* makeTestDatabase((sql) =>
      Effect.sync(() => {
        statements.push(sql);
        return sql.includes('from "core"."tenant_module_states"') ? [{}, {}] : [];
      }),
    );

    const conflict = yield* reconcileCoreContext(database, LOCAL_AUTH_USER_ID, [PARTY_REGISTRY_MODULE_ID]).pipe(
      Effect.flip,
    );

    expect(conflict.code).toBe('local_conflict');
    expect(conflict.reason).toMatch(/module-state identity conflicts/u);
    expect(statements.some((sql) => sql.startsWith('insert into "core"."tenants"'))).toBe(true);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(!statements.includes('COMMIT')).toBe(true);
  }),
);

it.effect('native commit failure becomes a typed bootstrap error', () =>
  Effect.gen(function* testEffect9() {
    const database = yield* makeTestDatabase((sql) =>
      sql === 'COMMIT'
        ? Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                cause: new Error('connection closed'),
              }),
            }),
          )
        : Effect.succeed([]),
    );

    const error = yield* reconcileCoreContext(database, LOCAL_AUTH_USER_ID, []).pipe(Effect.flip);
    expect(error.code).toBe('local_persistence_failed');
  }),
);

it.effect('bootstrap preserves unrelated defects after native rollback', () =>
  Effect.gen(function* testEffect10() {
    const defect = new Error('unexpected query defect');
    const statements: string[] = [];
    const database = yield* makeTestDatabase((sql) =>
      Effect.suspend(() => {
        statements.push(sql);
        return sql.startsWith('select ') ? Effect.die(defect) : Effect.succeed([]);
      }),
    );

    const exit = yield* reconcileCoreContext(database, LOCAL_AUTH_USER_ID, []).pipe(Effect.exit);
    expect(exit).toEqual(Exit.die(defect));
    expect(statements.at(-1)).toBe('ROLLBACK');
  }),
);
