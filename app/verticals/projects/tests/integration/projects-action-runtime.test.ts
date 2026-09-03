// @effect-diagnostics processEnv:off
/* eslint-disable no-await-in-loop -- Cleanup order follows foreign-key dependencies. */
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Test-only generic runtime harness intentionally drives several generated Action registrations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Effect, Exit } from 'effect';
import { Pool } from 'pg';
import { ContextAccess } from '@app/core-runtime';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { loadDatabaseConfig } from '../../../../packages/core-runtime/src/db/config.ts';
import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { ModuleStateDeniedError } from '../../../../packages/core-runtime/src/modules/module-state-gate-errors.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { createProjectAction } from '../../src/actions/create-project.action.ts';
import { archiveProjectAction } from '../../src/actions/archive-project.action.ts';
import { moveProjectAction } from '../../src/actions/move-project.action.ts';
import { unarchiveProjectAction } from '../../src/actions/unarchive-project.action.ts';
import { updateProjectAction } from '../../src/actions/update-project.action.ts';
import { readProjectRead } from '../../src/api/read-project.read.ts';

const adminUrl = process.env['DATABASE_ADMIN_URL']?.trim();
const runtimeUrl = process.env['DATABASE_URL']?.trim();
const enabled = adminUrl !== undefined && runtimeUrl !== undefined;

test(
  'Create Project uses the real Action runtime for idempotency, authorization denial, and durable evidence',
  { skip: enabled ? false : 'DATABASE_ADMIN_URL and DATABASE_URL are required' },
  async () => {
    assert.ok(adminUrl);
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const ownerPrincipalId = principalId;
    const authBindingId = randomUUID();
    const idempotencyKey = `projects-create-${randomUUID()}`;
    const admin = new Pool({ connectionString: adminUrl });
    const principal = {
      authBindingId,
      authContextRef: `better-auth-session:${randomUUID()}`,
      authMethod: 'session' as const,
      principalId,
      tenantId,
    };
    const transport = { correlationId: randomUUID(), idempotencyKey };
    const payload = {
      name: 'Runtime Project',
      ownerPrincipalId,
      parentProjectId: null,
      prefix: 'RTME',
      shortText: null,
    };
    const contextAccess = {
      legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
      modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
        Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
      resources: ({
        resources,
      }: {
        readonly resources: readonly {
          readonly moduleId: string;
          readonly resourceId: string;
          readonly resourceType: string;
        }[];
      }) =>
        Effect.succeed(
          resources.map(({ moduleId, resourceId, resourceType }) => ({
            decision: 'allowed' as const,
            key: `${moduleId}:${resourceType}:${resourceId}`,
          })),
        ),
      tenants: ({ tenantIds }: { readonly tenantIds: readonly string[] }) =>
        Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
    };
    try {
      await admin.query(
        "insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Projects runtime test', 'active', 'en')",
        [tenantId, `projects-${tenantId}`],
      );
      await admin.query(
        "insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Projects test principal', 'active')",
        [principalId, tenantId],
      );
      await admin.query(
        "insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type, provider_subject_id, status) values ($1, $2, $3, 'better_auth', 'user', $4, 'active')",
        [authBindingId, tenantId, principalId, `projects-user-${principalId}`],
      );
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* runtimeTest() {
            const configuration = yield* loadDatabaseConfig({
              environment: { DATABASE_URL: runtimeUrl },
            });
            const database = yield* makeCoreDatabase(configuration);
            const runtime = makeActionRuntime(
              database,
              makeActionRepository(),
              { checkActionPermission: () => Effect.succeed('allowed' as const) },
              testOperationalScopeResolver,
              { ...openActionRuntimeOptions, contextAccess },
            );
            const run = () =>
              runtime
                .runAction({ payload, principal, registration: createProjectAction, transport })
                .pipe(Effect.provideService(ContextAccess, contextAccess));
            const created = yield* run();
            const retry = yield* Effect.exit(run());
            const parent = yield* runtime
              .runAction({
                payload: { ...payload, prefix: 'PARN' },
                principal,
                registration: createProjectAction,
                transport: {
                  correlationId: randomUUID(),
                  idempotencyKey: `projects-parent-${randomUUID()}`,
                },
              })
              .pipe(Effect.provideService(ContextAccess, contextAccess));
            const readRuntime = makeReadRuntime(
              database,
              openActionRuntimeOptions.moduleEntrypointGateway,
              testOperationalScopeResolver,
              contextAccess,
            );
            const read = yield* readRuntime.runRead({
              input: { projectId: created.projectId },
              principal,
              registration: readProjectRead,
              transport: { correlationId: randomUUID() },
            });
            const deniedReadRuntime = makeReadRuntime(
              database,
              openActionRuntimeOptions.moduleEntrypointGateway,
              testOperationalScopeResolver,
              {
                ...contextAccess,
                tenants: ({ tenantIds }) =>
                  Effect.succeed(tenantIds.map((key) => ({ decision: 'denied' as const, key }))),
              },
            );
            const deniedRead = yield* Effect.exit(
              deniedReadRuntime.runRead({
                input: { projectId: created.projectId },
                principal,
                registration: readProjectRead,
                transport: { correlationId: randomUUID() },
              }),
            );
            const runMutation = (
              registration:
                | typeof archiveProjectAction
                | typeof unarchiveProjectAction
                | typeof updateProjectAction
                | typeof moveProjectAction,
              mutationPayload: unknown,
            ) =>
              runtime.runAction({
                payload: mutationPayload,
                principal,
                registration: registration as never,
                transport: {
                  correlationId: randomUUID(),
                  idempotencyKey: `projects-runtime-${randomUUID()}`,
                },
              });
            const moved = yield* runMutation(moveProjectAction, {
              parentProjectId: parent.projectId,
              projectId: created.projectId,
            });
            const archived = yield* runMutation(archiveProjectAction, {
              projectId: created.projectId,
            });
            const readableArchived = yield* readRuntime.runRead({
              input: { projectId: created.projectId },
              principal,
              registration: readProjectRead,
              transport: { correlationId: randomUUID() },
            });
            const blockedUpdate = yield* Effect.exit(
              runMutation(updateProjectAction, { name: 'Blocked', projectId: created.projectId }),
            );
            const blockedMove = yield* Effect.exit(
              runMutation(moveProjectAction, {
                parentProjectId: null,
                projectId: created.projectId,
              }),
            );
            const unarchived = yield* runMutation(unarchiveProjectAction, {
              projectId: created.projectId,
            });
            const concurrentArchiveUpdate = yield* Effect.promise(() =>
              Promise.allSettled([
                Effect.runPromise(
                  runMutation(archiveProjectAction, { projectId: created.projectId }),
                ),
                Effect.runPromise(
                  runMutation(updateProjectAction, {
                    name: 'Concurrent',
                    projectId: created.projectId,
                  }),
                ),
              ]),
            );
            const finalRead = yield* readRuntime.runRead({
              input: { projectId: created.projectId },
              principal,
              registration: readProjectRead,
              transport: { correlationId: randomUUID() },
            });
            const deniedRuntime = makeActionRuntime(
              database,
              makeActionRepository(),
              { checkActionPermission: () => Effect.succeed('denied' as const) },
              testOperationalScopeResolver,
              { ...openActionRuntimeOptions, contextAccess },
            );
            const denied = yield* Effect.exit(
              deniedRuntime
                .runAction({
                  payload: { ...payload, prefix: 'DENY' },
                  principal,
                  registration: createProjectAction,
                  transport: {
                    correlationId: randomUUID(),
                    idempotencyKey: `projects-denied-${randomUUID()}`,
                  },
                })
                .pipe(Effect.provideService(ContextAccess, contextAccess)),
            );
            const moduleDeniedRuntime = makeActionRuntime(
              database,
              makeActionRepository(),
              { checkActionPermission: () => Effect.succeed('allowed' as const) },
              testOperationalScopeResolver,
              {
                ...openActionRuntimeOptions,
                moduleEntrypointGateway: {
                  ...openActionRuntimeOptions.moduleEntrypointGateway,
                  check: () =>
                    Effect.fail(
                      new ModuleStateDeniedError({
                        code: 'module_state_denied',
                        reason: 'Projects is inactive for this test',
                      }),
                    ),
                },
              },
            );
            const moduleDenied = yield* Effect.exit(
              moduleDeniedRuntime
                .runAction({
                  payload: { ...payload, prefix: 'MODU' },
                  principal,
                  registration: createProjectAction,
                  transport: {
                    correlationId: randomUUID(),
                    idempotencyKey: `projects-module-denied-${randomUUID()}`,
                  },
                })
                .pipe(Effect.provideService(ContextAccess, contextAccess)),
            );
            return {
              archived,
              blockedMove,
              blockedUpdate,
              concurrentArchiveUpdate,
              created,
              denied,
              deniedRead,
              finalRead,
              moduleDenied,
              moved,
              parent,
              read,
              readableArchived,
              retry,
              unarchived,
            };
          }),
        ),
      );
      assert.equal(result.created.createdByPrincipalId, principalId);
      assert.equal(result.created.tenantId, tenantId);
      assert.equal(result.read.projectId, result.created.projectId);
      assert.equal(result.moved.parentProjectId, result.parent.projectId);
      assert.equal(result.archived.lifecycleState, 'archived');
      assert.equal(result.readableArchived.lifecycleState, 'archived');
      assert.equal(Exit.isFailure(result.blockedUpdate), true);
      assert.equal(Exit.isFailure(result.blockedMove), true);
      assert.equal(result.unarchived.lifecycleState, 'active');
      assert.equal(result.concurrentArchiveUpdate[0]?.status, 'fulfilled');
      assert.equal(result.finalRead.lifecycleState, 'archived');
      assert.equal(Exit.isFailure(result.retry), true);
      assert.equal(Exit.isFailure(result.denied), true);
      assert.equal(Exit.isFailure(result.moduleDenied), true);
      assert.equal(Exit.isFailure(result.deniedRead), true);
      const rows = await admin.query(
        'select count(*)::int as count from projects.projects where tenant_id = $1',
        [tenantId],
      );
      assert.equal(rows.rows[0]?.count, 2);
      const invocation = await admin.query(
        'select action_invocation_id from core.action_invocations where idempotency_key = $1',
        [idempotencyKey],
      );
      assert.equal(invocation.rowCount, 1);
      const invocationId = invocation.rows[0]?.action_invocation_id;
      const [events, accesses] = await Promise.all([
        admin.query(
          'select count(*)::int as count from core.domain_events where action_invocation_id = $1',
          [invocationId],
        ),
        admin.query(
          'select count(*)::int as count from core.data_access_events where action_invocation_id = $1',
          [invocationId],
        ),
      ]);
      assert.equal(events.rows[0]?.count, 1);
      assert.equal(accesses.rows[0]?.count, 1);
      const lifecycleEvents = await admin.query(
        "select event_type, count(*)::int as count from core.domain_events where tenant_id = $1 and event_type in ('projects.project.archived.v1', 'projects.project.unarchived.v1') group by event_type order by event_type",
        [tenantId],
      );
      assert.deepEqual(
        lifecycleEvents.rows.map((row) => [row.event_type, row.count]),
        [
          ['projects.project.archived.v1', 2],
          ['projects.project.unarchived.v1', 1],
        ],
      );
      const reads = await admin.query(
        "select outcome, count(*)::int as count from core.data_access_events where tenant_id = $1 and evidence_policy_key = 'projects.core.api.read-project.evidence.v1' group by outcome order by outcome",
        [tenantId],
      );
      assert.deepEqual(
        reads.rows.map((row) => [row.outcome, row.count]),
        [
          ['allowed', 3],
          ['denied', 1],
        ],
      );
    } finally {
      await admin.query('delete from projects.projects where tenant_id = $1', [tenantId]);
      for (const table of [
        'outbox_messages',
        'domain_events',
        'data_access_events',
        'audit_events',
      ]) {
        await admin.query(`delete from core.${table} where tenant_id = $1`, [tenantId]);
      }
      await admin.query('delete from core.action_invocations where tenant_id = $1', [tenantId]);
      await admin.query('delete from core.principal_auth_bindings where tenant_id = $1', [
        tenantId,
      ]);
      await admin.query('delete from core.principals where tenant_id = $1', [tenantId]);
      await admin.query('delete from core.tenants where tenant_id = $1', [tenantId]);
      await admin.end();
    }
  },
);
