#!/usr/bin/env node
/**
 * Noninteractive AKROS stage bootstrap, after workload publication and before composition publication.
 * Requires ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage and DATABASE_ADMIN_URL.
 * `node scripts/demo/symmy-demo-exchange-authority.mts --mode apply` (default), or --mode verify.
 *
 * Symmy's native enrollment inventory cannot enroll demo owner operations. This narrowly scoped administrator
 * update uses its source-family lock, route row locks, outstanding-work refusal, change-token trigger and
 * enrollment audit. The existing tenant-only product Read is narrowed to the approved company after matching its
 * source against the company writer. Source identities, physical route IDs, lifecycle policies and old operations remain.
 * Core's workload writers grant company-bound machine authority. No Role, Action receipt or route proof is minted.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';

import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { writeWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/binding-store.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/bindings.ts';
import { writeWorkloadCompanyBindings } from '../../packages/core-runtime/src/access/workloads/company-bindings.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/company-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/store.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { defineDatabaseIdentityEnrollment } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { demoOrderExportOperation } from '../../verticals/merchandise/shared/apis/demo-order-export.ts';
import {
  demoCatalogRevisionOperation,
  SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD,
} from '../../verticals/merchandise/shared/apis/demo-catalog-revision.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import { stageWorkloadBindingIds, stageWorkloadCompanyIds } from './register-stage-workloads.mts';

export const symmyDemoExchangeScope = {
  tenantId: TenantIdSchema.make('bceaa540-13eb-5508-9ac0-9ed7e40a2ee9'),
  legalEntityId: LegalEntityIdSchema.make('c0c78a3e-6e2a-57e0-9d0d-86253499fee7'),
  principalId: PrincipalIdSchema.make('90620f06-db0a-41ae-be48-4866258f6ea0'),
};
export const SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE = '1a24b716-0542-40d5-8906-c78554b7436d';
export const symmyDemoExchangeOperations = {
  productsBatch: {
    operation: {
      moduleId: 'demo.merchandise',
      entrypointKey: 'demo.merchandise.import-source-catalog',
      schemaVersion: '1',
    },
    effectKey: 'demo-catalog-import-v1',
    workloadKey: SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD,
  },
  adminProducts: {
    operation: {
      moduleId: demoOrderExportOperation.moduleId,
      entrypointKey: demoOrderExportOperation.entrypointKey,
      schemaVersion: demoOrderExportOperation.schemaVersion,
    },
    effectKey: 'demo-order-export-v1',
    workloadKey: demoOrderExportOperation.workloadKey,
  },
} as const;
const reason = 'Standing-approved AKROS stage demo Symmy catalog import and order export enrollment';
const attribution = 'ontos:stage:symmy-demo-exchange-authority:v1';
const enrollment = defineDatabaseIdentityEnrollment([]);
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Uuid = Schema.String.check(Schema.isUUID());
export const SymmyDemoExchangeRouteSchema = Schema.Struct({
  active: Schema.Boolean,
  changeToken: Schema.Int,
  configuration: JsonObject,
  legalEntityId: Schema.NullOr(Uuid),
  principalId: Uuid,
  routeCode: Schema.NullOr(Schema.String),
  routeId: Uuid,
  routeKey: Schema.Literals(['productsBatch', 'adminProducts']),
  tenantId: Uuid,
});
type Route = typeof SymmyDemoExchangeRouteSchema.Type;
type RouteKey = Route['routeKey'];

export const symmyDemoExchangeRouteOperations = (routeKey: RouteKey) =>
  routeKey === 'productsBatch'
    ? [
        symmyDemoExchangeOperations.productsBatch,
        {
          effectKey: 'demo-catalog-revision-v1',
          operation: {
            moduleId: demoCatalogRevisionOperation.moduleId,
            entrypointKey: demoCatalogRevisionOperation.entrypointKey,
            schemaVersion: demoCatalogRevisionOperation.schemaVersion,
          },
        },
      ]
    : [symmyDemoExchangeOperations.adminProducts];

export class SymmyDemoExchangeAuthorityError extends Schema.TaggedError<SymmyDemoExchangeAuthorityError>()(
  'SymmyDemoExchangeAuthorityError',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new SymmyDemoExchangeAuthorityError({ reason });

/** Validate the known plan, but retain the original JSON, including owner fields unknown to this release. */
export const symmyDemoExchangeConfiguration = Effect.fn('SymmyDemoExchange.configuration')(function* configuration(
  raw: unknown,
  routeKey: RouteKey,
) {
  let current = yield* Schema.decodeUnknownEffect(JsonObject)(raw);
  let changed = false;
  for (const addition of symmyDemoExchangeRouteOperations(routeKey)) {
    const plan = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(current);
    const existing = plan.items
      .flatMap(({ effects }) => effects)
      .filter(
        ({ operation }) =>
          operation.moduleId === addition.operation.moduleId &&
          operation.entrypointKey === addition.operation.entrypointKey,
      );
    if (existing.some(({ operation }) => operation.schemaVersion !== addition.operation.schemaVersion)) {
      return yield* fail(`The ${routeKey} demo operation is already enrolled at another version`);
    }
    if (existing.length > 0) continue;
    const index = plan.items.findIndex(({ effects }) => effects.length < 32);
    if (index < 0) return yield* fail(`The ${routeKey} configuration has no capacity for the demo operation`);
    if (plan.items[index]?.effects.some(({ effectKey }) => effectKey === addition.effectKey)) {
      return yield* fail(`The ${routeKey} demo effect key already names another operation`);
    }
    const items = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(JsonObject))(current.items);
    const selected = items[index];
    if (selected === undefined) return yield* fail('The selected Symmy configuration item is absent');
    const effects = yield* Schema.decodeUnknownEffect(Schema.Array(JsonObject))(selected.effects);
    const updated = {
      ...current,
      items: items.map((item, position) =>
        position === index
          ? { ...item, effects: [...effects, { effectKey: addition.effectKey, operation: addition.operation }] }
          : item,
      ),
    };
    yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(updated);
    current = updated;
    changed = true;
  }
  return { changed, configuration: current };
});

/** The read route is discovered from live enrollment, never guessed or substituted for a write route. */
export const planSymmyDemoExchangeRoutes = Effect.fn('SymmyDemoExchange.plan')(function* plan(rows: readonly Route[]) {
  if (
    rows.length !== 2 ||
    rows.some(
      (row) =>
        !row.active ||
        row.tenantId !== symmyDemoExchangeScope.tenantId ||
        (row.legalEntityId !== symmyDemoExchangeScope.legalEntityId &&
          !(row.routeKey === 'adminProducts' && row.legalEntityId === null)) ||
        row.principalId !== symmyDemoExchangeScope.principalId ||
        row.routeCode !== null,
    )
  ) {
    return yield* fail(
      'Exactly the active AKROS products write route and company-qualified product read route are required',
    );
  }
  const products = rows.filter(({ routeKey }) => routeKey === 'productsBatch');
  const reads = rows.filter(({ routeKey }) => routeKey === 'adminProducts');
  if (products.length !== 1 || products[0]?.routeId !== SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE || reads.length !== 1) {
    return yield* fail('The existing productsBatch/adminProducts routes are absent, ambiguous or rebound');
  }
  const [product] = products;
  const [read] = reads;
  if (product === undefined || read === undefined) return yield* fail('The product source pair is absent');
  const sourceOf = (row: Route) => Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(row.configuration);
  const productPlan = yield* sourceOf(product);
  const readPlan = yield* sourceOf(read);
  const logicalSourceId = productPlan.sourceRouteId;
  const first = productPlan.items[0].source;
  if (
    logicalSourceId === undefined ||
    readPlan.sourceRouteId !== logicalSourceId ||
    [...productPlan.items, ...readPlan.items].some(
      ({ source }) => source.issuerId !== first.issuerId || source.sourceNamespace !== first.sourceNamespace,
    )
  ) {
    return yield* fail('The product reader and company writer do not share the same enrolled logical source');
  }
  return yield* Effect.forEach(
    rows,
    (route) =>
      symmyDemoExchangeConfiguration(route.configuration, route.routeKey).pipe(
        Effect.map((change) => ({
          ...route,
          ...change,
          changed: change.changed || route.legalEntityId === null,
          previousLegalEntityId: route.legalEntityId,
          legalEntityId: symmyDemoExchangeScope.legalEntityId,
        })),
      ),
    { concurrency: 1 },
  );
});

const requireStage = Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
  Effect.flatMap((environment) =>
    environment === 'stage' ? Effect.void : Effect.fail(fail('Symmy demo exchange authority is restricted to stage')),
  ),
);
export const SymmyDemoExchangeAuthorityLive = Layer.unwrap(
  Effect.gen(function* adminLayer() {
    yield* requireStage;
    const url = yield* Config.Redacted('DATABASE_ADMIN_URL');
    return PgClient.layer({ url, maxConnections: 1 });
  }),
).pipe(Layer.provide(Reactivity.layer));

export const bootstrapSymmyDemoExchangeAuthority = Effect.fn('SymmyDemoExchange.bootstrap')(function* bootstrap(
  mode: 'apply' | 'verify' = 'apply',
) {
  yield* requireStage;
  const sql = yield* PgClient.PgClient;
  const executor = yield* makeWithDefaults({ relations: coreRelations });
  const { tenantId, legalEntityId, principalId } = symmyDemoExchangeScope;
  return yield* sql.withTransaction(
    Effect.gen(function* exchangeTransaction() {
      // symmyRouteEnrollmentLockKey groups both productsBatch and adminProducts in the products source family.
      const lock = ['symmy-route-enrollment', tenantId, principalId, 'products'].join(':');
      yield* sql`select pg_advisory_xact_lock(hashtextextended(${lock},0))`;
      const rows = yield* sql`select active, change_token as "changeToken", fixture_plan as configuration,
        legal_entity_id as "legalEntityId", principal_id as "principalId", route_code as "routeCode",
        route_id as "routeId", route_key as "routeKey", tenant_id as "tenantId"
        from symmy_integration.job_routes
        where tenant_id=${tenantId} and principal_id=${principalId}
          and (legal_entity_id=${legalEntityId} or (route_key='adminProducts' and legal_entity_id is null))
          and route_key in ('productsBatch','adminProducts') and active=true
        order by route_id for update`;
      const planned = yield* Schema.decodeUnknownEffect(Schema.Array(SymmyDemoExchangeRouteSchema))(rows).pipe(
        Effect.flatMap(planSymmyDemoExchangeRoutes),
      );
      if (mode === 'verify' && planned.some(({ changed }) => changed)) {
        return yield* fail('The demo exchange operations have not been enrolled');
      }
      for (const route of planned.filter(({ changed }) => changed)) {
        const checks = yield* sql`select
          exists(select 1 from symmy_integration.import_jobs j
            join symmy_integration.job_effects e on e.tenant_id=j.tenant_id and e.job_id=j.job_id
            where j.tenant_id=${tenantId} and j.route_id=${route.routeId} and e.state<>'settled'
              and not exists(select 1 from symmy_integration.job_retention_tombstones t
                where t.tenant_id=j.tenant_id and t.job_id=j.job_id)) as jobs,
          exists(select 1 from symmy_integration.sync_admissions a
            where a.tenant_id=${tenantId} and a.route_id=${route.routeId} and a.retention_receipt is null) as admissions`;
        yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              admissions: Schema.Literal(false),
              jobs: Schema.Literal(false),
            }),
          ]),
        )(checks).pipe(
          Effect.mapError(() =>
            fail(
              `Route ${route.routeId} has outstanding work; settle or retain it through Symmy before replacing its epoch`,
            ),
          ),
        );
      }
      const people = yield* sql`select m.principal_id as "principalId"
        from core.access_memberships m join core.access_scopes s using(tenant_id,scope_id)
        join core.principals p on p.tenant_id=m.tenant_id and p.principal_id=m.principal_id
        where m.tenant_id=${tenantId} and s.legal_entity_id is null and m.kind='owner' and m.status='active'
          and p.kind='human' and p.status='active' and m.valid_from<=clock_timestamp()
          and (m.valid_until is null or m.valid_until>clock_timestamp())
        order by m.principal_id limit 1`;
      const [owner] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ principalId: PrincipalIdSchema })]),
      )(people);
      const eligibility = yield* sql`select exists(select 1 from core.principals
        where tenant_id=${tenantId} and principal_id=${principalId} and kind='integration' and status='active') as principal,
        exists(select 1 from core.legal_entities
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and status='active') as company`;
      yield* Schema.decodeUnknownEffect(
        Schema.Tuple([
          Schema.Struct({
            company: Schema.Literal(true),
            principal: Schema.Literal(true),
          }),
        ]),
      )(eligibility);
      const scope = yield* stageScopeOf({ tenantId, principalId: owner.principalId });
      const database = { enrollment, executor };
      yield* sql`set local role ontos_runtime`;
      yield* installOperationalScope(executor, scope, enrollment);
      const grants = [];
      for (const addition of Object.values(symmyDemoExchangeOperations)) {
        const workloadKey = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(addition.workloadKey);
        const current = yield* sql`select binding_id as "bindingId", status from core.access_workload_bindings
          where tenant_id=${tenantId} and principal_id=${principalId} and workload_key=${workloadKey} for update`;
        const bindings = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              bindingId: AccessWorkloadBindingIdSchema,
              status: Schema.Literals(['active', 'revoked']),
            }),
          ),
        )(current);
        const active = bindings.filter(({ status }) => status === 'active');
        if (active.length > 1 || (active.length === 0 && bindings.length > 0)) {
          return yield* fail(`Workload ${workloadKey} is revoked or ambiguous; bootstrap never revives revoked policy`);
        }
        const ids = stageWorkloadBindingIds(tenantId, principalId, workloadKey);
        const bindingId = active[0]?.bindingId ?? AccessWorkloadBindingIdSchema.make(ids.bindingId);
        const registrations = yield* sql`select company_binding_id as "companyBindingId",
          legal_entity_id as "legalEntityId", status from core.access_workload_company_bindings
          where tenant_id=${tenantId} and workload_binding_id=${bindingId} for update`;
        const companies = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              companyBindingId: AccessWorkloadCompanyBindingIdSchema,
              legalEntityId: LegalEntityIdSchema,
              status: Schema.Literals(['active', 'revoked']),
            }),
          ),
        )(registrations);
        const company = companies.filter(({ status }) => status === 'active');
        if (
          company.length > 1 ||
          (company.length === 0 && companies.length > 0) ||
          company.some((row) => row.legalEntityId !== legalEntityId)
        ) {
          return yield* fail(`Workload ${workloadKey} has a revoked or different company registration`);
        }
        const companyIds = stageWorkloadCompanyIds(tenantId, bindingId, legalEntityId);
        if (mode === 'apply') {
          const createdAt = DateTime.toDateUtc(yield* DateTime.now);
          yield* writeWorkloadBindings(database, scope, {
            bindings: [
              {
                bindingId,
                createdAt,
                incarnation: AccessWorkloadBindingIdSchema.make(ids.bindingIncarnation),
                principalId,
                tenantId,
                workloadKey,
              },
            ],
          });
          yield* writeWorkloadCompanyBindings(database, scope, {
            bindings: [
              {
                companyBindingId:
                  company[0]?.companyBindingId ??
                  AccessWorkloadCompanyBindingIdSchema.make(companyIds.companyBindingId),
                createdAt,
                incarnation: AccessWorkloadCompanyBindingIdSchema.make(companyIds.companyIncarnation),
                legalEntityId,
                tenantId,
                workloadBindingId: bindingId,
              },
            ],
          });
        }
        const authority = yield* makeDrizzleAccessWorkloadBindings(database).readWorkloadAuthority({
          principalId,
          tenantId,
          scope,
        });
        if (
          !authority.workloadKeys.has(workloadKey) ||
          !authority.activeCompanyIds.has(legalEntityId) ||
          (mode === 'verify' && (active.length !== 1 || company.length !== 1))
        ) {
          return yield* fail(`Core did not admit workload ${workloadKey} in the AKROS company`);
        }
        grants.push({ workloadKey, bindingId, legalEntityId });
      }
      yield* sql`reset role`;
      const routes = [];
      for (const route of planned) {
        if (mode === 'apply' && route.changed) {
          const updated = yield* sql`update symmy_integration.job_routes
            set fixture_plan=${sql.json(route.configuration)},legal_entity_id=${legalEntityId}
            where tenant_id=${tenantId} and principal_id=${principalId}
              and legal_entity_id is not distinct from ${route.previousLegalEntityId}::uuid
              and route_id=${route.routeId} and change_token=${route.changeToken} and active=true
            returning change_token as "changeToken"`;
          const [written] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ changeToken: Schema.Int })]),
          )(updated);
          if (written.changeToken === route.changeToken) return yield* fail('The Symmy route epoch did not advance');
          yield* sql`insert into symmy_integration.route_enrollment_records
            (tenant_id,legal_entity_id,route_id,route_key,route_revision,change_token,change,
              previous_change_token,previous_revision,stated_operator_ref,reason)
            select tenant_id,legal_entity_id,route_id,route_key,route_revision,change_token,'replace',
              ${route.changeToken},route_revision,${attribution},${reason}
            from symmy_integration.job_routes where tenant_id=${tenantId} and route_id=${route.routeId}`;
        }
        const confirmed = yield* sql`select route_id as "routeId" from symmy_integration.job_routes
          where tenant_id=${tenantId} and principal_id=${principalId} and legal_entity_id=${legalEntityId}
            and route_id=${route.routeId} and route_key=${route.routeKey} and active=true
            and fixture_plan=${sql.json(route.configuration)}::jsonb`;
        yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ routeId: Uuid })]))(confirmed);
        routes.push({
          routeId: route.routeId,
          routeKey: route.routeKey,
          outcome: route.changed ? 'replaced' : 'verified',
          operations: symmyDemoExchangeRouteOperations(route.routeKey).map(({ operation }) => operation),
        });
      }
      return { grants, routes };
    }),
  );
});

const command = Command.make(
  'symmy-demo-exchange-authority',
  { mode: Flag.Literals('mode', ['apply', 'verify']).pipe(Flag.withDefault('apply')) },
  ({ mode }) =>
    bootstrapSymmyDemoExchangeAuthority(mode).pipe(Effect.flatMap((result) => Console.log({ mode, ...result }))),
);
if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(SymmyDemoExchangeAuthorityLive),
      Effect.provide(NodeServices.layer),
      Effect.tapError(() =>
        Console.error('AKROS demo exchange authority did not converge; no route proof or owner receipt was issued'),
      ),
    ),
  );
}
