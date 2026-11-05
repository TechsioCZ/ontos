import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { tenants } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadServiceFactory } from '../../src/reads/definition.ts';
import type { ReadHandlerContext } from '../../src/reads/context.ts';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '11111111-1111-4111-8111-111111111111',
    authContextRef: 'better-auth-session:read-harness',
    authMethod: 'session',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
  }),
  correlationId: 'read-harness',
};
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-05T12:00:00.000Z'));
interface Services {
  readonly read: Effect.Effect<readonly string[], ReadHandlerUnavailable>;
}
const makeServices: ReadServiceFactory<Services> = (transaction) =>
  Effect.succeed({
    read: transaction
      .select({ tenantId: tenants.tenantId })
      .from(tenants)
      .where(sql`${tenants.createdAt} <= transaction_timestamp()`)
      .pipe(
        Effect.map((rows) => rows.map((row) => row.tenantId)),
        Effect.mapError(
          () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' }),
        ),
      ),
  });
const registration = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'test.read-harness.read-harness',
      moduleKey: 'test.read-harness',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.read-harness.read-harness.evidence' },
    inputSchema: Schema.Struct({}),
    legalEntityScope: 'forbidden',
    owningModuleKey: 'test.read-harness',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'test.read-harness.read-harness',
    resultSchema: Schema.Array(Schema.String),
    schemaVersion: '1',
  },
  (_input, context: ReadHandlerContext<Services>) =>
    context.services.read.pipe(Effect.map((result) => ({ evidence: { resultCount: result.length }, result }))),
  makeServices,
  () => ({ kind: 'tenant', permission: 'read_party_identity' }),
);
/**
 * The same owner read, decided by the v2 gate instead of a legacy permission target. `makeReadTestHarness`
 * used to derive the *scope* admission from the legacy `permissionDecision`, so a v2 suite that scripted
 * only `access` was refused before it reached the gate (`OperationContextDenied`, empty selectable
 * companies). These two cases pin the split: the gate answer admits the scope, and `scopeAccess` alone
 * can still refuse it.
 */
const protectedRegistration = defineRead(
  {
    accessDeclaration: {
      key: 'test.read-harness.read-harness.protected',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'inventory', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'test.read-harness.read-harness-protected',
      moduleKey: 'test.read-harness',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.read-harness.read-harness-protected.evidence' },
    inputSchema: Schema.Struct({}),
    legalEntityScope: 'forbidden',
    owningModuleKey: 'test.read-harness',
    policies: [],
    readKey: 'test.read-harness.read-harness-protected',
    resultSchema: Schema.Array(Schema.String),
    schemaVersion: '1',
  },
  (_input, context: ReadHandlerContext<Services>) =>
    context.services.read.pipe(Effect.map((result) => ({ evidence: { resultCount: result.length }, result }))),
  makeServices,
);
const protectedInvocation = {
  input: {},
  principal: scope,
  registration: protectedRegistration,
  transport: { correlationId: scope.correlationId },
};
/** This scripted SQL probe is a synthetic owner, not the production Inventory module. */
const ownerBase = makeModuleContractFixture({ appId: 'read-harness-test', moduleId: 'test.read-harness' }).manifest;
const ownerRegistration = defineVerticalRuntimeRegistration({
  actions: [],
  manifest: defineOntosModuleManifest({
    ...ownerBase,
    publicSurface: { ...ownerBase.publicSurface, actions: [], api: {}, components: {} },
  }),
  outboxWorkers: [],
  reads: [registration, protectedRegistration],
});
const invocation = { input: {}, principal: scope, registration, transport: { correlationId: scope.correlationId } };

it.layer(NodeCrypto.layer)('read test harness', (suite) => {
  suite.effect('defaults permission to denied before owner SQL and persists denied evidence', () =>
    Effect.gen(function* defaultDenied() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Owner SQL must not run'),
        operationTime,
        ownerRegistration,
        scope,
      });
      const failure = yield* harness.runtime.runRead(invocation).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages).not.toContain('scope_installed');
    }),
  );

  suite.effect('defaults owner authorization to denied after scope installation', () =>
    Effect.gen(function* ownerDefaultDenied() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Owner SQL must not run'),
        operationTime,
        ownerRegistration,
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime.runRead(invocation).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().stages).toContain('scope_installed');
      expect(harness.snapshot().statements).toContain('ROLLBACK');
    }),
  );

  suite.effect('runs the original factory and handler with installed scope and commits allowed evidence', () =>
    Effect.gen(function* realReadLifecycle() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.sql).toContain('"core"."tenants"');
          expect(query.scope).toEqual({ legalEntityId: '', tenantId: scope.tenantId });
          return Effect.succeed([{ tenantId: scope.tenantId }]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        permissionDecision: 'allowed',
        scope,
      });
      expect(yield* harness.runtime.runRead(invocation)).toEqual([scope.tenantId]);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().ownerQueries[0]?.sql).toContain('transaction_timestamp()');
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages.slice(-3)).toEqual(['handler_executed', 'result_decoded', 'evidence_persisted']);
      expect(harness.snapshot().statements.at(-1)).toBe('COMMIT');
    }),
  );

  suite.effect('keeps owner SQL outages typed and rolls back without allowed evidence', () =>
    Effect.gen(function* typedOwnerOutage() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () =>
          Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled outage' }) })),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime.runRead(invocation).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().evidenceWrites).toBe(0);
      expect(harness.snapshot().statements.at(-1)).toBe('ROLLBACK');
    }),
  );

  suite.effect('admits the scope of a v2 harness that scripts only the gate answer', () =>
    Effect.gen(function* v2ScopeAdmission() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        scope,
      });
      expect(yield* harness.runtime.runRead(protectedInvocation)).toEqual([scope.tenantId]);
      expect(harness.snapshot().stages).toContain('scope_installed');
    }),
  );

  suite.effect('answers the scope from the v2 script even when a legacy answer disagrees', () =>
    Effect.gen(function* v2WinsOverLegacy() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        // A stale legacy answer must not be able to deny the scope any more: the v2 script is the
        // authority, and the codemod deleting this key cannot change what the read does.
        ownerRegistration,
        permissionDecision: 'denied',
        scope,
      });
      expect(yield* harness.runtime.runRead(protectedInvocation)).toEqual([scope.tenantId]);
      expect(harness.snapshot().stages).toContain('scope_installed');
    }),
  );

  suite.effect('keeps the legacy permissionDecision answer for a bag that has not migrated', () =>
    Effect.gen(function* legacyScopeAdmission() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        permissionDecision: 'allowed',
        scope,
      });
      // The transitional harness keeps working: no bag changes meaning while the migration runs.
      expect(yield* harness.runtime.runRead(protectedInvocation)).toEqual([scope.tenantId]);
      expect(harness.snapshot().stages).toContain('scope_installed');
    }),
  );
});
