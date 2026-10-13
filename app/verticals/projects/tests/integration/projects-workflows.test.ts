import { PgClient } from '@effect/sql-pg';
import { humanPrincipalCandidatesForTransaction, loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { sql } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Option, Match, Result, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/unstable/reactivity';
import type { ProjectsTransaction } from '../../src/db/types.ts';
import { projectsRelations } from '../../src/db/schema.ts';
import { makeProjectPersistenceService } from '../../src/services/project-persistence.service.ts';
import type { ProjectPersistenceError } from '../../src/services/project-persistence.service.ts';
import { ProjectLifecycleConflict } from '../../shared/domain/project-lifecycle-conflict.ts';

class AdminSql extends Context.Service<AdminSql, PgClient.PgClient>()('ProjectsTests/AdminSql') {}
const runtimeClientLive = Layer.unwrap(
  loadDatabaseConnectionPair({ envPath: new URL('../../../../.env', import.meta.url).pathname }).pipe(
    Effect.map((pair) => PgClient.layer({ url: Redacted.make(pair.runtime.connectionString) })),
  ),
);
const adminClientLive = Layer.effect(
  AdminSql,
  loadDatabaseConnectionPair({ envPath: new URL('../../../../.env', import.meta.url).pathname }).pipe(
    Effect.flatMap((pair) => PgClient.makeClient({ url: Redacted.make(pair.admin.connectionString) })),
  ),
);
const testLive = Layer.mergeAll(runtimeClientLive, adminClientLive).pipe(Layer.provide(Reactivity.layer));

const workflows = () =>
  Effect.gen(function* assertProjectWorkflows() {
    const admin = yield* AdminSql;
    const database = yield* makeWithDefaults({ relations: projectsRelations });
    const principalId = '20000000-0000-4000-8000-000000000001';
    const tenantA = '10000000-0000-4000-8000-000000003160';
    const tenantB = '10000000-0000-4000-8000-000000003161';
    const scoped = <Value>(
      tenantId: string,
      operation: (
        service: ReturnType<typeof makeProjectPersistenceService>,
      ) => Effect.Effect<Value, ProjectPersistenceError>,
    ) =>
      database.transaction((transaction) =>
        transaction
          .execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects')
          .pipe(
            Effect.andThen(
              operation(makeProjectPersistenceService(transaction, { operationId: 'projects-test', tenantId })),
            ),
          ),
      );
    const values = (prefix: string, parentProjectId: string | null = null) => ({
      createdByPrincipalId: principalId,
      name: 'Project',
      owner: { eligibilityChecked: true as const, principalId },
      parentProjectId,
      prefix,
      shortText: null,
    });
    const cleanup = admin`delete from projects.projects where tenant_id in (${tenantA}, ${tenantB})`;
    yield* cleanup;
    yield* Effect.gen(function* assertWorkflows() {
      const root = yield* scoped(tenantA, (service) => service.create(values('ROOT')));
      const child = yield* scoped(tenantA, (service) => service.create(values('CHILD', root.projectId)));
      const leaf = yield* scoped(tenantA, (service) => service.create(values('LEAF', child.projectId)));
      const foreign = yield* scoped(tenantB, (service) => service.create(values('ROOT')));
      const hidden = yield* scoped(tenantA, (service) => service.find(foreign.projectId));
      expect(Schema.is(Schema.TaggedStruct('not_found', {}))(hidden)).toBe(true);
      yield* scoped(tenantA, (service) => service.transitionLifecycle(root.projectId, 'archived'));
      const blockedUpdate = yield* scoped(tenantA, (service) =>
        service.update({ name: 'Blocked', owner: values('ROOT').owner, projectId: child.projectId, shortText: null }),
      ).pipe(Effect.result);
      expect(Result.isFailure(blockedUpdate)).toBe(true);
      const blockedMove = yield* scoped(tenantA, (service) => service.move(child.projectId, null)).pipe(Effect.flip);
      expect(Schema.is(ProjectLifecycleConflict)(blockedMove)).toBe(true);
      const blockedArchive = yield* scoped(tenantA, (service) =>
        service.transitionLifecycle(child.projectId, 'archived'),
      ).pipe(Effect.flip);
      expect(Schema.is(ProjectLifecycleConflict)(blockedArchive)).toBe(true);
      yield* scoped(tenantA, (service) => service.transitionLifecycle(root.projectId, 'active'));
      const moved = yield* scoped(tenantA, (service) => service.move(child.projectId, null));
      expect(Option.isNone(moved.parentProjectId)).toBe(true);
      const leafLookup = yield* scoped(tenantA, (service) => service.find(leaf.projectId));
      const actualLeaf = yield* Match.value(leafLookup).pipe(
        Match.tags({
          found: ({ value }) => Effect.succeed(value),
          not_found: () => Effect.fail(new Error('Leaf disappeared after subtree move')),
        }),
        Match.exhaustive,
      );
      expect(actualLeaf).toEqual(leaf);
      const collisions = yield* Effect.all(
        [
          scoped(tenantA, (service) => service.create(values('RACE'))).pipe(Effect.exit),
          scoped(tenantA, (service) => service.create(values('race'))).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      expect(collisions.filter(Exit.isSuccess)).toHaveLength(1);
      const first = yield* scoped(tenantA, (service) => service.create(values('ONE')));
      const second = yield* scoped(tenantA, (service) => service.create(values('TWO')));
      const opposing = yield* Effect.all(
        [
          scoped(tenantA, (service) => service.move(first.projectId, second.projectId)).pipe(Effect.exit),
          scoped(tenantA, (service) => service.move(second.projectId, first.projectId)).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      expect(opposing.filter(Exit.isSuccess)).toHaveLength(1);
      expect(moved.projectId).toBe(child.projectId);
      expect(moved.prefix).toBe(child.prefix);
      expect(moved.createdAt).toEqual(child.createdAt);
    }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
  });

const checkHumanCandidates = (
  transaction: ProjectsTransaction & { execute: Effect.Success<ReturnType<typeof makeWithDefaults>>['execute'] },
  {
    foreignId,
    humanId,
    inactiveId,
    serviceId,
    tenantId,
  }: { foreignId: string; humanId: string; inactiveId: string; serviceId: string; tenantId: string },
) =>
  Effect.gen(function* checkCandidates() {
    yield* transaction.execute(sql`select set_config('ontos.tenant_id',${tenantId},true)`, 'objects');
    const candidates = humanPrincipalCandidatesForTransaction({
      scope: { tenantId },
      select: transaction.select.bind(transaction),
    });
    expect(yield* candidates.search('Projects')).toEqual([{ displayName: 'Projects Human', principalId: humanId }]);
    expect(yield* candidates.find(serviceId)).toBeUndefined();
    expect(yield* candidates.find(inactiveId)).toBeUndefined();
    expect(yield* candidates.find(foreignId)).toBeUndefined();
  });

const humanCandidates = () =>
  Effect.gen(function* assertIdentityWorkflow() {
    const admin = yield* AdminSql;
    const database = yield* makeWithDefaults({ relations: projectsRelations });
    const tenantId = '10000000-0000-4000-8000-000000003162';
    const otherTenant = '10000000-0000-4000-8000-000000003163';
    const humanId = '20000000-0000-4000-8000-000000003162';
    const serviceId = '20000000-0000-4000-8000-000000003163';
    const inactiveId = '20000000-0000-4000-8000-000000003164';
    const foreignId = '20000000-0000-4000-8000-000000003165';
    // Operator-only fixtures seed Core identity; application factories use only its public typed service.
    yield* admin`insert into core.tenants (tenant_id,slug,name,status,default_locale) values (${tenantId}, 'projects-owner-test','Projects test','active','en'), (${otherTenant},'projects-owner-other','Other test','active','en')`;
    const cleanup = Effect.gen(function* cleanupIdentity() {
      yield* admin`delete from core.principals where tenant_id in (${tenantId},${otherTenant})`;
      yield* admin`delete from core.tenants where tenant_id in (${tenantId},${otherTenant})`;
    });
    yield* Effect.gen(function* assertHumanCandidates() {
      yield* admin`insert into core.principals (principal_id,tenant_id,kind,display_name,status) values (${humanId},${tenantId},'human','Projects Human','active'),(${serviceId},${tenantId},'service','Projects Service','active'),(${inactiveId},${tenantId},'human','Projects Inactive','disabled'),(${foreignId},${otherTenant},'human','Projects Foreign','active')`;
      yield* database.transaction((transaction) =>
        checkHumanCandidates(transaction, { foreignId, humanId, inactiveId, serviceId, tenantId }),
      );
    }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
  });

it.layer(testLive)('Projects PostgreSQL', (test) => {
  test.effect('enforces tenant isolation, Prefix races, stable subtree moves, and ancestor archive guards', workflows);
  test.effect('Core candidate lookup exposes only active human Principals in the operation Tenant', humanCandidates);
});
