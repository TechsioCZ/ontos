import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from 'effect';
import { PgTypes } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  scriptedPgClientLayer,
  testSqlConnection,
} from '../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import { demoCatalogRevisionOperation } from '../../verticals/merchandise/shared/apis/demo-catalog-revision.ts';
import {
  bootstrapSymmyDemoExchangeAuthority,
  planSymmyDemoExchangeRoutes,
  SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE,
  SymmyDemoExchangeRouteSchema,
  SymmyDemoExchangeConfigurationSchema,
  symmyDemoExchangeConfiguration,
  symmyDemoExchangeOperations,
  symmyDemoExchangeRouteOperations,
  symmyDemoExchangeScope,
} from './symmy-demo-exchange-authority.mts';
import { LegalEntityIdSchema, PrincipalIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { SymmyLifecycleRouteIdSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-notification.ts';
import { stageWorkloadBindingIds, stageWorkloadCompanyIds } from './register-stage-workloads.mts';

const invalidIdentifier = 'not-a-uuid';
const demoModuleId = 'demo.merchandise';
const catalogImportEntrypoint = 'demo.merchandise.import-source-catalog';
const catalogRevisionEntrypoint = 'demo.merchandise.api.demo-catalog-revision';
const updateRoute = 'update symmy_integration.job_routes';
const readRouteId = SymmyLifecycleRouteIdSchema.make('b0000000-0000-4000-8000-000000000001');
const ownerId = PrincipalIdSchema.make('b0000000-0000-4000-8000-000000000002');
const originalConfiguration = () => ({
  extension: { keepUnknownOwnerConfiguration: true },
  items: [
    {
      effects: [
        {
          effectKey: 'original-catalog-operation',
          extension: { untouchedEffectMetadata: true },
          operation: {
            entrypointKey: 'commerce.catalog.create-product',
            moduleId: 'commerce.catalog',
            schemaVersion: '1',
          },
        },
      ],
      extension: { untouchedItemMetadata: true },
      itemKey: 'actual-source-template',
      source: {
        entityKind: 'PRODUCT',
        issuerId: 'actual-symmy-issuer',
        sourceNamespace: 'actual-erp-namespace',
        sourceRecordId: 'original-template-record',
      },
    },
  ],
  sourceMappingVersion: 'actual-mapping-v7',
  sourceRouteId: 'b0000000-0000-4000-8000-000000000003',
  sourceRouteRevision: 'actual-source-v4',
});
const route = (routeKey: 'productsBatch' | 'adminProducts') =>
  Schema.decodeUnknownSync(SymmyDemoExchangeRouteSchema)({
    ...symmyDemoExchangeScope,
    active: true,
    changeToken: routeKey === 'productsBatch' ? 41 : 42,
    configuration: originalConfiguration(),
    routeCode: null,
    routeId: routeKey === 'productsBatch' ? SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE : readRouteId,
    routeKey,
  });

it.effect('adds only the appropriate owner operation and preserves the complete original source configuration', () =>
  Effect.gen(function* additivePlans() {
    for (const routeKey of ['productsBatch', 'adminProducts'] as const) {
      const original = originalConfiguration();
      const patched = yield* symmyDemoExchangeConfiguration(original, routeKey);
      expect(patched.changed).toBe(true);
      const parsed = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(patched.configuration);
      expect(parsed.items[0].effects.map(({ operation }) => operation)).toEqual([
        original.items[0]?.effects[0]?.operation,
        ...symmyDemoExchangeRouteOperations(routeKey).map(({ operation }) => operation),
      ]);
      expect(patched.configuration).toEqual({
        ...original,
        items: [
          {
            ...original.items[0],
            effects: [
              ...(original.items[0]?.effects ?? []),
              ...symmyDemoExchangeRouteOperations(routeKey).map(({ effectKey, operation }) => ({
                effectKey,
                operation,
              })),
            ],
          },
        ],
      });
      const repeated = yield* symmyDemoExchangeConfiguration(patched.configuration, routeKey);
      expect(repeated.changed).toBe(false);
      expect(repeated.configuration).toEqual(patched.configuration);
    }
  }),
);

it.effect('discovers the actual adminProducts identity without changing revisions or crossing read/write routes', () =>
  Effect.gen(function* actualReadRoute() {
    for (const legalEntityId of [null, symmyDemoExchangeScope.legalEntityId]) {
      const encoded = { ...Schema.encodeSync(SymmyDemoExchangeRouteSchema)(route('adminProducts')), legalEntityId };
      const decoded = yield* Schema.decodeUnknownEffect(SymmyDemoExchangeRouteSchema)(encoded);
      expect(Schema.encodeSync(SymmyDemoExchangeRouteSchema)(decoded)).toEqual(encoded);
      const { legalEntityId: _legalEntityId, ...withoutCompany } = encoded;
      const { routeCode: _routeCode, ...withoutCode } = encoded;
      for (const invalid of [
        withoutCompany,
        withoutCode,
        { ...encoded, legalEntityId: invalidIdentifier },
        { ...encoded, principalId: invalidIdentifier },
        { ...encoded, routeId: invalidIdentifier },
        { ...encoded, tenantId: invalidIdentifier },
      ]) {
        expect(
          Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(SymmyDemoExchangeRouteSchema)(invalid))),
        ).toBe(true);
      }
    }
    const rows = [route('adminProducts'), route('productsBatch')];
    const planned = yield* planSymmyDemoExchangeRoutes(rows);
    expect(planned.map(({ routeId }) => routeId)).toEqual([readRouteId, SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE]);
    for (const entry of planned) {
      const plan = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(entry.configuration);
      const operations = plan.items.flatMap(({ effects }) => effects.map(({ operation }) => operation.entrypointKey));
      expect(operations).toContain(symmyDemoExchangeOperations[entry.routeKey].operation.entrypointKey);
      const other = entry.routeKey === 'productsBatch' ? 'adminProducts' : 'productsBatch';
      expect(operations).not.toContain(symmyDemoExchangeOperations[other].operation.entrypointKey);
    }
    for (const invalid of [
      rows.slice(0, 1),
      [...rows, route('adminProducts')],
      [route('adminProducts'), { ...route('productsBatch'), routeId: readRouteId }],
      [route('adminProducts'), { ...route('productsBatch'), active: false }],
      [route('adminProducts'), { ...route('productsBatch'), legalEntityId: Option.none() }],
      [route('adminProducts'), { ...route('productsBatch'), principalId: ownerId }],
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(planSymmyDemoExchangeRoutes(invalid)))).toBe(true);
    }
  }),
);

it.effect(
  'upgrades an existing import-only enrollment with the exact catalog revision Read and its native workload',
  () =>
    Effect.gen(function* exactRevisionAuthorization() {
      const original = originalConfiguration();
      const importOnly = {
        ...original,
        items: [
          {
            ...original.items[0],
            effects: [
              ...(original.items[0]?.effects ?? []),
              {
                effectKey: 'existing-demo-import',
                operation: {
                  entrypointKey: catalogImportEntrypoint,
                  moduleId: demoModuleId,
                  schemaVersion: '1',
                },
              },
            ],
          },
        ],
      };
      const patched = yield* symmyDemoExchangeConfiguration(importOnly, 'productsBatch');
      const plan = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(patched.configuration);
      const operations = plan.items.flatMap(({ effects }) => effects.map(({ operation }) => operation));
      expect(patched.changed).toBe(true);
      expect(operations.filter(({ entrypointKey }) => entrypointKey === catalogRevisionEntrypoint)).toEqual([
        {
          entrypointKey: catalogRevisionEntrypoint,
          moduleId: demoModuleId,
          schemaVersion: '1',
        },
      ]);
      expect(operations.filter(({ entrypointKey }) => entrypointKey === catalogImportEntrypoint)).toHaveLength(1);
      expect(demoCatalogRevisionOperation).toMatchObject({
        entrypointKey: catalogRevisionEntrypoint,
        moduleId: demoModuleId,
        schemaVersion: '1',
        workloadKey: 'demo.merchandise.symmy-catalog-import',
      });
      expect(symmyDemoExchangeOperations.productsBatch.workloadKey).toBe(demoCatalogRevisionOperation.workloadKey);
      expect((yield* symmyDemoExchangeConfiguration(patched.configuration, 'productsBatch')).changed).toBe(false);
    }),
);

it.effect('refuses conflicting versions and effect keys rather than replacing existing authority', () =>
  Effect.gen(function* conflicts() {
    for (const conflict of [
      {
        effectKey: 'existing-demo',
        operation: { ...symmyDemoExchangeOperations.productsBatch.operation, schemaVersion: '2' },
      },
      {
        effectKey: symmyDemoExchangeOperations.productsBatch.effectKey,
        operation: { entrypointKey: 'commerce.catalog.other', moduleId: 'commerce.catalog', schemaVersion: '1' },
      },
    ]) {
      const original = originalConfiguration();
      const input = { ...original, items: [{ ...original.items[0], effects: [conflict] }] };
      expect(Exit.isFailure(yield* Effect.exit(symmyDemoExchangeConfiguration(input, 'productsBatch')))).toBe(true);
    }
  }),
);

/** Real Effect SQL/Drizzle and Core writers over a scripted wire connection; no native database or services. */
const fixture = (
  options: {
    readonly outstanding?: boolean;
    readonly revoked?: boolean;
    readonly tenantReader?: boolean;
  } = {},
) => {
  const routes = [route('productsBatch'), route('adminProducts')].map((row) => ({
    ...Schema.encodeSync(SymmyDemoExchangeRouteSchema)(row),
  }));
  if (options.tenantReader === true) {
    const reader = routes.find(({ routeKey }) => routeKey === 'adminProducts');
    if (reader !== undefined) {
      reader.legalEntityId = null;
    }
  }
  const statements: string[] = [];
  const keys = Object.values(symmyDemoExchangeOperations).map(({ workloadKey }) => workloadKey);
  const bindings = new Set<string>();
  const companies = new Set<string>();
  let role = 'stage_admin';
  let scoped = false;
  const { legalEntityId, principalId, tenantId } = symmyDemoExchangeScope;
  const bindingId = (key: string) => stageWorkloadBindingIds(tenantId, principalId, key).bindingId;
  const coreStatement = (sql: string, parameters: readonly unknown[]) => {
    if (sql.includes('from core.access_workload_bindings')) {
      expect(scoped).toBe(true);
      const key = String(parameters[2]);
      return bindings.has(key) || options.revoked === true
        ? [{ bindingId: bindingId(key), status: options.revoked === true ? 'revoked' : 'active' }]
        : [];
    }
    if (sql.includes('from core.access_workload_company_bindings')) {
      const key = keys.find((candidate) => bindingId(candidate) === parameters[1]);
      return key !== undefined && companies.has(key)
        ? [
            {
              companyBindingId: stageWorkloadCompanyIds(tenantId, bindingId(key), legalEntityId).companyBindingId,
              legalEntityId,
              status: 'active',
            },
          ]
        : [];
    }
    if (sql.includes('insert into "core"."access_workload_bindings"')) {
      const key = keys.find((candidate) => parameters.includes(candidate));
      if (key === undefined) {
        throw new Error('The Core writer must bind a declared demo workload');
      }
      bindings.add(key);
    }
    if (sql.includes('insert into "core"."access_workload_company_bindings"')) {
      const key = keys.find((candidate) => parameters.includes(bindingId(candidate)));
      if (key === undefined) {
        throw new Error('The Core writer must register the actual workload binding');
      }
      companies.add(key);
    }
    if (sql.includes('"core"."access_scope_fences"')) {
      return [{ state: 'Ready' }];
    }
    if (sql.includes('left join "core"."access_workload_company_bindings"')) {
      return keys
        .filter((key) => bindings.has(key))
        .map((key) => ({
          legalEntityId: companies.has(key) ? legalEntityId : null,
          workloadKey: key,
        }));
    }
    return [];
  };
  const routeStatement = (sql: string, parameters: readonly unknown[]) => {
    if (sql.startsWith(updateRoute)) {
      const selected = routes.find((entry) => parameters.includes(entry.routeId));
      if (selected === undefined) {
        throw new Error('Only a discovered exchange route may be updated');
      }
      const [parameter] = parameters;
      expect(PgTypes.isParameter(parameter)).toBe(true);
      if (!PgTypes.isParameter(parameter)) {
        throw new Error('Expected the native PostgreSQL JSON parameter');
      }
      selected.configuration = Schema.decodeUnknownSync(SymmyDemoExchangeConfigurationSchema)(parameter.value);
      if (sql.includes('legal_entity_id=')) {
        selected.legalEntityId = legalEntityId;
      }
      selected.changeToken += 1;
      return [{ changeToken: selected.changeToken }];
    }
    if (sql.includes('select route_id as "routeId" from symmy_integration.job_routes')) {
      const selected = routes.find((entry) => parameters.includes(entry.routeId));
      return selected === undefined ? [] : [{ routeId: selected.routeId }];
    }
    return [];
  };
  const execute = (sql: string, parameters: readonly unknown[]) =>
    Effect.sync(() => {
      statements.push(sql);
      if (sql === 'set local role ontos_runtime') {
        role = 'ontos_runtime';
      }
      if (sql === 'reset role') {
        role = 'stage_admin';
      }
      if (sql.includes('set_config(')) {
        scoped = true;
        return [{ legal_entity_id: '', role, tenant_id: tenantId }];
      }
      if (sql === 'select current_user::text as role') {
        return [{ role }];
      }
      if (sql.includes('from symmy_integration.job_routes') && sql.includes('for update')) {
        return routes;
      }
      if (sql.includes('as jobs') && sql.includes('as admissions')) {
        return [{ admissions: false, jobs: options.outstanding ?? false }];
      }
      if (sql.includes('from core.access_memberships')) {
        return [{ principalId: ownerId }];
      }
      if (sql.includes('as principal,') && sql.includes('as company')) {
        return [{ company: true, principal: true }];
      }
      if (
        sql.startsWith(updateRoute) ||
        sql.includes('select route_id as "routeId" from symmy_integration.job_routes')
      ) {
        return routeStatement(sql, parameters);
      }
      return coreStatement(sql, parameters);
    });
  const live = scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provide(Reactivity.layer));
  const run = (mode: 'apply' | 'verify', environment = 'stage') =>
    bootstrapSymmyDemoExchangeAuthority(mode).pipe(
      Effect.provide(live),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment,
        }),
      ),
    );
  return { bindings, companies, routes, run, statements };
};

it.effect('applies through Core writers and real route rows; a second apply and verify rotate no further epochs', () =>
  Effect.gen(function* bootstrapTwice() {
    const state = fixture();
    const applied = yield* state.run('apply');
    expect(applied.grants).toHaveLength(2);
    expect(applied.grants.map(({ workloadKey }) => workloadKey)).toEqual([
      symmyDemoExchangeOperations.productsBatch.workloadKey,
      symmyDemoExchangeOperations.adminProducts.workloadKey,
    ]);
    expect(applied.routes.map(({ outcome }) => outcome)).toEqual(['replaced', 'replaced']);
    expect(state.bindings.size).toBe(2);
    expect(state.companies.size).toBe(2);
    const tokens = state.routes.map(({ changeToken }) => changeToken);
    const repeated = yield* state.run('apply');
    expect(repeated.routes.map(({ outcome }) => outcome)).toEqual(['verified', 'verified']);
    yield* state.run('verify');
    expect(state.routes.map(({ changeToken }) => changeToken)).toEqual(tokens);
    expect(state.statements.filter((sql) => sql.startsWith(updateRoute))).toHaveLength(2);
    expect(
      state.statements.filter((sql) => sql.startsWith('insert into symmy_integration.route_enrollment_records')),
    ).toHaveLength(2);
    expect(
      state.statements
        .filter((sql) => sql.startsWith('update '))
        .every((sql) => sql.includes('set fixture_plan=') && !sql.includes('inventoryStockBatch')),
    ).toBe(true);
  }),
);

it.effect('refuses outstanding work, revoked grants and verify-before-apply without writing route changes', () =>
  Effect.gen(function* refuseUnsafeEnrollment() {
    for (const [options, mode] of [
      [{ outstanding: true }, 'apply'],
      [{ revoked: true }, 'apply'],
      [{}, 'verify'],
    ] as const) {
      const state = fixture(options);
      expect(Exit.isFailure(yield* Effect.exit(state.run(mode)))).toBe(true);
      expect(state.statements.some((sql) => sql.startsWith(updateRoute))).toBe(false);
      expect(
        state.statements.some((sql) => sql.startsWith('insert into symmy_integration.route_enrollment_records')),
      ).toBe(false);
      expect(state.statements.some((sql) => sql.startsWith('ROLLBACK'))).toBe(true);
    }
  }),
);

it.effect('narrows the actual tenant-only reader without creating ambiguous duplicate routes and then converges', () =>
  Effect.gen(function* narrowExistingReader() {
    const state = fixture({ tenantReader: true });
    const reader = state.routes.find(({ routeKey }) => routeKey === 'adminProducts');
    const originalId = reader?.routeId;
    expect(reader?.legalEntityId).toBeNull();
    yield* state.run('apply');
    expect(reader?.routeId).toBe(originalId);
    expect(reader?.legalEntityId).toBe(symmyDemoExchangeScope.legalEntityId);
    expect(state.routes).toHaveLength(2);
    yield* state.run('apply');
    yield* state.run('verify');
    expect(state.statements.filter((sql) => sql.startsWith(updateRoute))).toHaveLength(2);
  }),
);

it.effect('refuses narrowing an unrelated reader or another company instead of borrowing write source authority', () =>
  Effect.gen(function* refuseUnrelatedReader() {
    const reader = { ...route('adminProducts'), legalEntityId: Option.none() };
    for (const invalid of [
      { ...reader, configuration: { ...reader.configuration, sourceRouteId: 'c0000000-0000-4000-8000-000000000001' } },
      { ...reader, legalEntityId: Option.some(LegalEntityIdSchema.make('c0000000-0000-4000-8000-000000000002')) },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(planSymmyDemoExchangeRoutes([route('productsBatch'), invalid])))).toBe(
        true,
      );
    }
    const blocked = fixture({ outstanding: true, tenantReader: true });
    expect(Exit.isFailure(yield* Effect.exit(blocked.run('apply')))).toBe(true);
    expect(blocked.routes.find(({ routeKey }) => routeKey === 'adminProducts')?.legalEntityId).toBeNull();
  }),
);

it.effect('rejects production before issuing any database statement', () =>
  Effect.gen(function* stageOnly() {
    const state = fixture();
    const outcome = yield* Effect.exit(state.run('apply', 'production'));
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(JSON.stringify(outcome)).toContain('restricted to stage');
    expect(JSON.stringify(outcome)).not.toContain('Service not found');
    expect(state.statements).toHaveLength(0);
  }),
);
