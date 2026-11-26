import { NodeCrypto } from '@effect/platform-node';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessWorkloadBindingStoreLive } from '../../src/access/workloads/binding-store.ts';
import { AccessWorkloadCompanyBindingStoreLive } from '../../src/access/workloads/company-bindings.ts';
import { internalWorkloadPrincipalId } from '../../src/auth/module-credentials.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { registerAdditiveCompanyInternalWorkloads } from '../../src/install/release-internal-workloads.ts';
import { testCoreDatabase } from '../../src/testing/owner-evidence.ts';
import { scriptedPgClientLayer, testSqlConnection } from '../../src/testing/scripted-pg-client.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const declarations = ['demo.crm.alpha', 'demo.crm.beta'].map((workloadKey) => ({
  appId: 'crm',
  label: workloadKey,
  moduleKey: 'demo.crm',
  workloadKey,
}));
const principalIds = declarations.map(({ workloadKey }) =>
  internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey }),
);
const input = { declarations, legalEntityId, runReference: 'release-order-test', tenantId };
const FailurePointSchema = Schema.Literals(['read', 'scope', 'binding']);
type FailurePoint = typeof FailurePointSchema.Type;
const fixture = (failurePoint?: FailurePoint) => {
  const statements: string[] = [];
  const writes: string[] = [];
  const failure = new SqlError({
    reason: new ConnectionError({
      cause: {
        code: '42501',
        constraint: 'core_principals_platform_role_ck',
        detail: 'private database detail',
      },
    }),
  });
  const connection = testSqlConnection((sql, parameters) =>
    Effect.gen(function* executeStatement() {
      statements.push(sql);
      // Yield on every statement so parallel units/steps would interleave their writes.
      yield* Effect.yieldNow;
      if (sql.includes('current_user')) {
        return [{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }];
      }
      if (sql.startsWith('select') && sql.includes('"tenant_module_states"')) {
        if (failurePoint === 'read') {
          return yield* failure;
        }
        return [{ moduleKey: 'demo.crm' }];
      }
      if (sql.startsWith('select') && sql.includes('"legal_entities"')) {
        return [{ legalEntityId, legalName: 'Company', status: 'active' }];
      }
      if (sql.startsWith('select "kind", "platform_role"')) {
        return [{ kind: 'system', platformRole: 'access_release_actor', status: 'active', tenantId }];
      }
      if (sql.startsWith('select') && sql.includes('join "core"."tenants"')) {
        return [{ kind: 'system', principalStatus: 'active', tenantStatus: 'active' }];
      }
      if (sql.startsWith('select') && sql.includes('"access_scope_fences"')) {
        return [{ state: 'Ready' }];
      }
      if (sql.startsWith('insert into "core"."principals"')) {
        if (sql.includes('returning')) {
          const principalId = parameters.find(
            (value): value is string => Schema.is(Schema.String)(value) && principalIds.includes(value),
          );
          if (principalId === undefined) {
            return yield* Effect.die('Derived principal missing from insert');
          }
          writes.push(`principal:${principalId}`);
          return [{ principalId }];
        }
        if (failurePoint === 'scope') {
          return yield* failure;
        }
      }
      if (sql.startsWith('insert into "core"."access_workload_bindings"')) {
        writes.push('workload');
        if (failurePoint === 'binding') {
          return yield* failure;
        }
      }
      if (sql.startsWith('insert into "core"."access_workload_company_bindings"')) {
        writes.push('company');
      }
      return [];
    }),
  );
  const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
  );
  const layer = Layer.mergeAll(
    AccessReleaseStoreLive,
    AccessWorkloadBindingStoreLive,
    AccessWorkloadCompanyBindingStoreLive,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        NodeCrypto.layer,
        Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      ),
    ),
  );
  const enroll = Effect.gen(function* enrollAdditive() {
    const context = yield* Layer.build(layer);
    const { executor } = Context.get(context, CoreDatabase);
    return yield* registerAdditiveCompanyInternalWorkloads(
      { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor },
      input,
    ).pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);
  return { enroll, statements, writes };
};

it.effect('enrolls each principal, workload and company sequentially before starting the next unit', () =>
  Effect.gen(function* orderedWrites() {
    const current = fixture();
    expect(yield* current.enroll).toEqual({ registered: 2, unchanged: 0 });
    expect(current.writes).toEqual(principalIds.flatMap((id) => [`principal:${id}`, 'workload', 'company']));
    expect(current.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(8);
    expect(current.statements.filter((sql) => sql === 'COMMIT')).toHaveLength(8);
    expect(current.statements).not.toContain('ROLLBACK');
  }),
);

it.effect('stops additive enrollment at the failed step without starting the next step or unit', () =>
  Effect.gen(function* failedStep() {
    const current = fixture('binding');
    const error = yield* current.enroll.pipe(Effect.flip);
    expect(current.writes).toEqual([`principal:${principalIds[0]}`, 'workload']);
    expect(current.statements).toContain('ROLLBACK');
    expect(error.reason).toBe('additive-step-bind-workload');
    expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
      enumerable: false,
      value: { reason: expect.stringContaining('the workload binding could not be written:') },
    });
    expect(error.sqlState).toBe('42501');
    expect(error.databaseConstraint).toBe('core_principals_platform_role_ck');
    expect(JSON.stringify(error)).not.toContain('private database detail');
  }),
);

it.effect('preserves bounded database diagnostics through tenant-read and release-scope failures', () =>
  Effect.gen(function* failureMetadata() {
    yield* Effect.forEach(
      ['read', 'scope'] as const,
      (point) =>
        Effect.gen(function* checkFailure() {
          const current = fixture(point);
          const error = yield* current.enroll.pipe(Effect.flip);
          expect(error.reason).toBe(point === 'read' ? 'additive-read-tenant' : 'additive-release-scope');
          expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
            enumerable: false,
            value: {
              reason: expect.stringContaining(
                point === 'read' ? 'the tenant could not be read (' : 'the release actor could not be ensured:',
              ),
            },
          });
          expect(error.sqlState).toBe('42501');
          expect(error.databaseConstraint).toBe('core_principals_platform_role_ck');
          expect(current.writes).toEqual([]);
          expect(current.statements).toContain('ROLLBACK');
          expect(JSON.stringify(error)).not.toContain('private database detail');
        }),
      { concurrency: 1, discard: true },
    );
  }),
);
