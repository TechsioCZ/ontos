import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Logger, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { makeContextAccess } from '../../src/permissions/context-access.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { prepareModuleStateSnapshot } from '../../src/modules/module-state-gate.ts';
import type { TenantModuleStateServiceContract } from '../../src/modules/tenant-module-state-service.ts';
import { TenantModuleStateReadUnavailableError } from '../../src/modules/tenant-module-state-errors.ts';
import { sanitizeErrorMessage } from '../../src/observability/unavailable-mapping.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const MAPPING_EVENT = 'governed_read.unavailable_mapped';

const captured = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

const failingClient = (cause: unknown, rpcCode?: number): SpiceDbPermissionClient => ({
  checkBulkPermissions: () => Effect.fail(spiceDbPermissionClientError(cause, rpcCode)),
  checkPermission: () => Effect.die(new Error('Action check must not run')),
  close: () => {},
});

it('redacts connection URLs and secret assignments from mapped failure messages', () => {
  const sanitized = sanitizeErrorMessage(
    'connect failed for postgresql://ontos:hunter2@db.internal:5432/ontos password=hunter3 token: abc123',
  );
  expect(sanitized).toBe('connect failed for <redacted-url> password=<redacted> token=<redacted>');
  expect(sanitizeErrorMessage('x'.repeat(500))).toHaveLength(200);
});

it.effect('logs one structured warning for a SpiceDB timeout mapped to unavailable', () =>
  Effect.gen(function* logsSpiceDbTimeout() {
    const entries: string[] = [];
    const timeout = new Cause.TimeoutError('secret deadline detail');
    const access = timeout.pipe(failingClient, makeContextAccess);
    const decisions = yield* access
      .legalEntities({ legalEntityIds: [legalEntityId], principalId, tenantId })
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
      .pipe(Effect.provide(captured(entries)));
    expect(decisions).toEqual([{ decision: 'unavailable', key: legalEntityId }]);
    const mapped = entries.filter((entry) => entry.includes(MAPPING_EVENT));
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toContain('"point":"spicedb-permission-check"');
    expect(mapped[0]).toContain('"phase":"read-permission"');
    expect(mapped[0]).toContain('"failureKind":"timeout"');
    expect(mapped[0]).toContain('"errorClass":"TimeoutError"');
    expect(mapped[0]).not.toContain('secret');
  }),
);

for (const [description, rpcCode, errorClass, failureKind] of [
  ['RPC deadline', 4, 'TimeoutError', 'timeout'],
  ['RPC transport failure', 14, 'SpiceDbPermissionClientError', 'client-error'],
  ['unclassified client failure', undefined, 'SpiceDbPermissionClientError', 'client-error'],
] as const) {
  const entries: string[] = [];
  it.layer(captured(entries))(`safe mapped warning for ${description}`, (suite) => {
    suite.effect('emits exactly one warning for the entire batch without raw failure details', () =>
      Effect.gen(function* logsSafeBatchFailure() {
        const secretCause = new Error('postgresql://ontos:secret@private.invalid password=secret token=secret');
        secretCause.name = 'private-secret-error-class';
        const access = makeContextAccess(failingClient(secretCause, rpcCode));
        const otherLegalEntityId = '20000000-0000-4000-8000-000000000002';
        const decisions = yield* access.legalEntities({
          legalEntityIds: [legalEntityId, otherLegalEntityId],
          principalId,
          tenantId,
        });
        expect(decisions).toEqual([
          { decision: 'unavailable', key: legalEntityId },
          { decision: 'unavailable', key: otherLegalEntityId },
        ]);
        const mapped = entries.filter((entry) => entry.includes(MAPPING_EVENT));
        expect(mapped).toHaveLength(1);
        expect(mapped[0]).toContain(`"errorClass":"${errorClass}"`);
        expect(mapped[0]).toContain(`"failureKind":"${failureKind}"`);
        expect(mapped[0]).not.toContain('secret');
        expect(mapped[0]).not.toContain('private');
        expect(mapped[0]).not.toContain('"cause"');
        expect(mapped[0]).not.toContain('"errorMessage"');
        expect(mapped[0]).not.toContain(principalId);
        expect(mapped[0]).not.toContain(tenantId);
        expect(mapped[0]).not.toContain(legalEntityId);
      }),
    );
  });
}

const successfulEntries: string[] = [];
it.layer(captured(successfulEntries))('successful context permission batch', (suite) => {
  suite.effect('preserves allowed and denied decisions without mapped warnings', () =>
    Effect.gen(function* noUnavailableWarning() {
      const client: SpiceDbPermissionClient = {
        checkBulkPermissions: (request) =>
          Effect.succeed(
            v1.CheckBulkPermissionsResponse.create({
              pairs: request.items.map((item, index) => ({
                request: item,
                response: {
                  item: {
                    permissionship:
                      index === 0
                        ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                        : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
                  },
                  oneofKind: 'item',
                },
              })),
            }),
          ),
        checkPermission: () => Effect.die(new Error('Action check must not run')),
        close: () => {},
      };
      const otherLegalEntityId = '20000000-0000-4000-8000-000000000002';
      const decisions = yield* makeContextAccess(client).legalEntities({
        legalEntityIds: [legalEntityId, otherLegalEntityId],
        principalId,
        tenantId,
      });
      expect(decisions).toEqual([
        { decision: 'allowed', key: legalEntityId },
        { decision: 'denied', key: otherLegalEntityId },
      ]);
      expect(successfulEntries.filter((entry) => entry.includes(MAPPING_EVENT))).toEqual([]);
    }),
  );
});

it.effect('logs the module-state acquisition failure with its underlying class and a redacted message', () =>
  Effect.gen(function* logsModuleStateFailure() {
    const entries: string[] = [];
    const descriptor = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'inventory.stock.page',
      moduleKey: 'inventory.stock',
      role: 'page',
    });
    const service: TenantModuleStateServiceContract = {
      getTenantModuleStates: () =>
        Effect.fail(
          new TenantModuleStateReadUnavailableError({
            cause: new Error('connect failed for postgresql://ontos:hunter2@db.internal:5432/ontos'),
            code: 'tenant_module_state_read_unavailable',
            reason: 'Tenant module state is temporarily unavailable',
          }),
        ),
      listActiveTenantModules: () => Effect.succeed([]),
      listTenantModuleStates: () => Effect.succeed([]),
    };
    const failure = yield* Effect.flip(prepareModuleStateSnapshot(service, tenantId, [descriptor])).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- Test-owned diagnostic logger capture.
      Effect.provide(captured(entries)),
    );
    expect(Predicate.isTagged(failure, 'ModuleStateCheckUnavailableError')).toBe(true);
    const mapped = entries.filter((entry) => entry.includes(MAPPING_EVENT));
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toContain('"point":"module-state-check"');
    expect(mapped[0]).toContain('"phase":"module-state-acquire"');
    expect(mapped[0]).toContain('TenantModuleStateReadUnavailableError');
    expect(mapped[0]).toContain('"errorMessage":"Tenant module state is temporarily unavailable"');
    expect(mapped[0]).not.toContain('hunter2');
  }),
);
