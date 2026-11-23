import { ConfigProvider, Effect, Exit, Layer, Schema } from 'effect';
import { PgTypes } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  scriptedPgClientLayer,
  testSqlConnection,
} from '../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import {
  bootstrapSymmyDemoExchangeAuthority,
  planSymmyDemoExchangeRoutes,
  SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE,
  SymmyDemoExchangeRouteSchema,
  symmyDemoExchangeConfiguration,
  symmyDemoExchangeOperations,
  symmyDemoExchangeRouteOperations,
  symmyDemoExchangeScope,
} from './symmy-demo-exchange-authority.mts';
import { stageWorkloadBindingIds, stageWorkloadCompanyIds } from './register-stage-workloads.mts';

const readRouteId = 'b0000000-0000-4000-8000-000000000001';
const ownerId = 'b0000000-0000-4000-8000-000000000002';
const originalConfiguration = () => ({
  extension: { keepUnknownOwnerConfiguration: true },
  sourceMappingVersion: 'actual-mapping-v7',
  sourceRouteId: 'b0000000-0000-4000-8000-000000000003',
  sourceRouteRevision: 'actual-source-v4',
  items: [
    {
      itemKey: 'actual-source-template',
      extension: { untouchedItemMetadata: true },
      source: {
        entityKind: 'PRODUCT',
        issuerId: 'actual-symmy-issuer',
        sourceNamespace: 'actual-erp-namespace',
        sourceRecordId: 'original-template-record',
      },
      effects: [
        {
          effectKey: 'original-catalog-operation',
          operation: {
            moduleId: 'commerce.catalog',
            entrypointKey: 'commerce.catalog.create-product',
            schemaVersion: '1',
          },
          extension: { untouchedEffectMetadata: true },
        },
      ],
    },
  ],
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
      [route('adminProducts'), { ...route('productsBatch'), legalEntityId: null }],
      [route('adminProducts'), { ...route('productsBatch'), principalId: ownerId }],
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(planSymmyDemoExchangeRoutes(invalid)))).toBe(true);
    }
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
        operation: { moduleId: 'commerce.catalog', entrypointKey: 'commerce.catalog.other', schemaVersion: '1' },
      },
    ]) {
      const original = originalConfiguration();
      const input = { ...original, items: [{ ...original.items[0], effects: [conflict] }] };
      expect(Exit.isFailure(yield* Effect.exit(symmyDemoExchangeConfiguration(input, 'productsBatch')))).toBe(true);
    }
  }),
);

/** Real Effect SQL/Drizzle and Core writers over a scripted wire connection; no native database or services. */
const fixture = (options: { readonly outstanding?: boolean; readonly revoked?: boolean } = {}) => {
  const routes = [route('productsBatch'), route('adminProducts')].map((row) => ({ ...row }));
  const statements: string[] = [];
  const keys = Object.values(symmyDemoExchangeOperations).map(({ workloadKey }) => workloadKey);
  const bindings = new Set<string>();
  const companies = new Set<string>();
  let role = 'stage_admin';
  let scoped = false;
  const { tenantId, principalId, legalEntityId } = symmyDemoExchangeScope;
  const bindingId = (key: string) => stageWorkloadBindingIds(tenantId, principalId, key).bindingId;
  const execute = (sql: string, parameters: readonly unknown[]) =>
    Effect.sync(() => {
      statements.push(sql);
      if (sql === 'set local role ontos_runtime') role = 'ontos_runtime';
      if (sql === 'reset role') role = 'stage_admin';
      if (sql.includes('set_config(')) {
        scoped = true;
        return [{ role, tenant_id: tenantId, legal_entity_id: '' }];
      }
      if (sql === 'select current_user::text as role') return [{ role }];
      if (sql.includes('from symmy_integration.job_routes') && sql.includes('for update')) return routes;
      if (sql.includes('as jobs') && sql.includes('as admissions')) {
        return [{ jobs: options.outstanding ?? false, admissions: false }];
      }
      if (sql.includes('from core.access_memberships')) return [{ principalId: ownerId }];
      if (sql.includes('as principal,') && sql.includes('as company')) return [{ principal: true, company: true }];
      if (sql.includes('from core.access_workload_bindings')) {
        expect(scoped).toBe(true);
        const key = String(parameters[2]);
        return bindings.has(key) || options.revoked === true
          ? [{ bindingId: bindingId(key), status: options.revoked === true ? 'revoked' : 'active' }]
          : [];
      }
      if (sql.includes('from core.access_workload_company_bindings')) {
        const key = keys.find((key) => bindingId(key) === parameters[1]);
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
        const key = keys.find((key) => parameters.includes(key));
        if (key === undefined) throw new Error('The Core writer must bind a declared demo workload');
        bindings.add(key);
      }
      if (sql.includes('insert into "core"."access_workload_company_bindings"')) {
        const key = keys.find((key) => parameters.includes(bindingId(key)));
        if (key === undefined) throw new Error('The Core writer must register the actual workload binding');
        companies.add(key);
      }
      if (sql.includes('"core"."access_scope_fences"')) return [{ state: 'Ready' }];
      if (sql.includes('left join "core"."access_workload_company_bindings"')) {
        return keys
          .filter((key) => bindings.has(key))
          .map((key) => ({
            legalEntityId: companies.has(key) ? legalEntityId : null,
            workloadKey: key,
          }));
      }
      if (sql.startsWith('update symmy_integration.job_routes')) {
        const selected = routes.find((entry) => parameters.includes(entry.routeId));
        if (selected === undefined) throw new Error('Only a discovered exchange route may be updated');
        const parameter = parameters[0];
        expect(PgTypes.isParameter(parameter)).toBe(true);
        if (!PgTypes.isParameter(parameter)) throw new Error('Expected the native PostgreSQL JSON parameter');
        selected.configuration = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(parameter.value);
        selected.changeToken += 1;
        return [{ changeToken: selected.changeToken }];
      }
      if (sql.includes('select route_id as "routeId" from symmy_integration.job_routes')) {
        const selected = routes.find((entry) => parameters.includes(entry.routeId));
        return selected === undefined ? [] : [{ routeId: selected.routeId }];
      }
      return [];
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
  return { run, statements, routes, bindings, companies };
};

it.effect('applies through Core writers and real route rows; a second apply and verify rotate no further epochs', () =>
  Effect.gen(function* bootstrapTwice() {
    const state = fixture();
    const applied = yield* state.run('apply');
    expect(applied.grants).toHaveLength(2);
    expect(applied.routes.map(({ outcome }) => outcome)).toEqual(['replaced', 'replaced']);
    expect(state.bindings.size).toBe(2);
    expect(state.companies.size).toBe(2);
    const tokens = state.routes.map(({ changeToken }) => changeToken);
    const repeated = yield* state.run('apply');
    expect(repeated.routes.map(({ outcome }) => outcome)).toEqual(['verified', 'verified']);
    yield* state.run('verify');
    expect(state.routes.map(({ changeToken }) => changeToken)).toEqual(tokens);
    expect(state.statements.filter((sql) => sql.startsWith('update symmy_integration.job_routes'))).toHaveLength(2);
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
      expect(state.statements.some((sql) => sql.startsWith('update symmy_integration.job_routes'))).toBe(false);
      expect(
        state.statements.some((sql) => sql.startsWith('insert into symmy_integration.route_enrollment_records')),
      ).toBe(false);
      expect(state.statements.some((sql) => sql.startsWith('ROLLBACK'))).toBe(true);
    }
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
