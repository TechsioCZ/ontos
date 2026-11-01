import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Redacted, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { StorefrontApplicationsResponseSchema } from '../../shared/apis/storefront-applications.ts';

class StorefrontApplicationsNativeSetupFailed extends Schema.TaggedError<StorefrontApplicationsNativeSetupFailed>()(
  'StorefrontApplicationsNativeSetupFailed',
  { reason: Schema.String },
) {}

const tenantId = '7a000000-0000-4000-8000-000000000001';
const otherTenantId = '7a000000-0000-4000-8000-000000000002';
const principalId = '7a000000-0000-4000-8000-0000000000aa';

const fixture = Effect.fn('storefront-registry.StorefrontApplicationsNative.fixture')(function* fixture() {
  const sourceConnections = yield* loadDatabaseConnectionPair();
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    // The isolated-fixture purpose allow-list is Core-owned; this owner's native suites share its approved purpose.
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections,
  });
  const child = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'pnpm', '--filter', '@app/storefront-registry', 'db:migrate'],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        DATABASE_URL: isolated.connections.runtime.connectionString,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (code !== 0) {
    return yield* new StorefrontApplicationsNativeSetupFailed({ reason: 'The isolated owner migration failed' });
  }
  const runtime = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.runtime.connectionString) });
  return { runtime };
});

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);

/** Routine payloads travel as JSON text parameters. */
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Runtime = Effect.Success<ReturnType<typeof fixture>>['runtime'];

/** Runs `statement` as ontos_runtime inside one transaction scoped to `scopeTenantId`. */
const scoped = <A, E>(runtime: Runtime, scopeTenantId: string, statement: Effect.Effect<A, E>) =>
  Effect.gen(function* scopedStatement() {
    yield* runtime.unsafe("select set_config('ontos.tenant_id', $1, true)", [scopeTenantId]);
    return yield* statement;
  }).pipe(runtime.withTransaction);

const register = (runtime: Runtime, scopeTenantId: string, storefrontAppId: string, invocation: string) =>
  scoped(
    runtime,
    scopeTenantId,
    runtime.unsafe<{ readonly payload: { readonly storefrontApplicationId: string } }>(
      'select payload from storefront_registry.register_storefront_application($1::uuid, $2::jsonb)',
      [
        scopeTenantId,
        jsonText({
          actionInvocationId: invocation,
          allowedChannels: ['B2C', 'B2B'],
          effectiveInterval: { effectiveFrom: '2026-09-01T10:00:00+02:00' },
          lifecycle: 'ACTIVE',
          principalId,
          reason: 'Native list fixture',
          recordedAt: '2026-09-01T08:00:00.000Z',
          storefrontAppId,
        }),
      ],
    ),
  );

const list = (runtime: Runtime, scopeTenantId: string, requestTenantId: string) =>
  scoped(
    runtime,
    scopeTenantId,
    runtime.unsafe<{ readonly payload: unknown }>(
      'select payload from storefront_registry.read_storefront_applications($1::uuid, $2::jsonb)',
      [requestTenantId, jsonText({ at: '2026-10-01T00:00:00.000Z' })],
    ),
  );

it.layer(services, { excludeTestServices: true })('Storefront Registry application list owner routine', (suite) => {
  suite.effect('lists only the scoped Tenant registrations at their current revision with canonical instants', () =>
    fixture().pipe(
      Effect.flatMap(({ runtime }) =>
        Effect.gen(function* listScopedRegistrations() {
          yield* register(runtime, tenantId, 'kavarna-doma-eshop', '7a000000-0000-4000-8000-000000000101');
          const [akros] = yield* register(
            runtime,
            tenantId,
            'akros-storefront',
            '7a000000-0000-4000-8000-000000000102',
          );
          yield* register(runtime, otherTenantId, 'foreign-shop', '7a000000-0000-4000-8000-000000000103');
          yield* scoped(
            runtime,
            tenantId,
            runtime.unsafe(
              'select payload from storefront_registry.revise_storefront_application($1::uuid, $2::jsonb)',
              [
                tenantId,
                jsonText({
                  actionInvocationId: '7a000000-0000-4000-8000-000000000104',
                  allowedChannels: ['B2C'],
                  effectiveInterval: {
                    effectiveFrom: '2026-09-01T08:00:00.000Z',
                    effectiveTo: '2027-01-01T00:00:00.000Z',
                  },
                  expectedRevision: 1,
                  lifecycle: 'SUSPENDED',
                  principalId,
                  reason: 'Native list fixture revision',
                  recordedAt: '2026-09-02T08:00:00.000Z',
                  storefrontApplicationRef: {
                    moduleId: 'commerce.storefront-registry',
                    resourceId: akros?.payload.storefrontApplicationId,
                    resourceType: 'commerce.storefront-registry.storefront-application',
                    tenantId,
                  },
                }),
              ],
            ),
          );
          const [row] = yield* list(runtime, tenantId, tenantId);
          const response = yield* Schema.decodeUnknownEffect(StorefrontApplicationsResponseSchema)(row?.payload);
          expect(response.observedAt).toBe('2026-10-01T00:00:00.000Z');
          expect(response.applications.map((application) => application.storefrontAppId)).toEqual([
            'akros-storefront',
            'kavarna-doma-eshop',
          ]);
          expect(response.applications[0]).toMatchObject({
            allowedChannels: ['B2C'],
            effectiveInterval: { effectiveFrom: '2026-09-01T08:00:00.000Z', effectiveTo: '2027-01-01T00:00:00.000Z' },
            lifecycle: 'SUSPENDED',
            revision: 2,
            storefrontApplicationRef: { resourceId: akros?.payload.storefrontApplicationId, tenantId },
          });
          expect(response.applications[1]).toMatchObject({
            allowedChannels: ['B2C', 'B2B'],
            effectiveInterval: { effectiveFrom: '2026-09-01T08:00:00.000Z' },
            lifecycle: 'ACTIVE',
            revision: 1,
          });
        }),
      ),
      Effect.scoped,
    ),
  );

  suite.effect('fails closed for a Tenant outside the scope and keeps raw tables unreadable for the runtime role', () =>
    fixture().pipe(
      Effect.flatMap(({ runtime }) =>
        Effect.gen(function* rejectForeignTenant() {
          const crossTenant = yield* list(runtime, tenantId, otherTenantId).pipe(Effect.result);
          expect(Result.isFailure(crossTenant)).toBe(true);
          const raw = yield* scoped(
            runtime,
            tenantId,
            runtime.unsafe('select storefront_app_id from storefront_registry.storefront_applications'),
          ).pipe(Effect.result);
          expect(Result.isFailure(raw)).toBe(true);
          const [empty] = yield* list(runtime, tenantId, tenantId);
          expect(empty?.payload).toEqual({ applications: [], observedAt: '2026-10-01T00:00:00.000Z' });
        }),
      ),
      Effect.scoped,
    ),
  );
});
