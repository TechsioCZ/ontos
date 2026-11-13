import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_DESCRIPTOR } from '../support/database-identities.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { tenants } from '../../src/db/schema.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '../../src/testing/module-contract.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadServiceFactory } from '../../src/reads/definition.ts';
import type { ReadHandlerContext, ReadLoadContext } from '../../src/reads/context.ts';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';

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
  {
    load: (_input, context: ReadLoadContext<Services>) =>
      context.services.read.pipe(Effect.map((result) => ({ evidence: { resultCount: result.length }, result }))),
  },
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
const compositionRevision = 'a'.repeat(64);
const composedScope = trustVerifiedGatewayPrincipalContext(scope, compositionRevision);
const composedInvocation = { ...invocation, principal: composedScope };

/** Synthetic Shell constructor definitions, captured before constructing the runtime under test. */
const shellDefinitions = (onLoad: () => void) => {
  const make = (key: string, role: 'api' | 'search') =>
    defineRead(
      {
        accessDeclaration: {
          key: `${key}.resolve`,
          kind: 'read',
          modes: ['run'],
          placement: { group: 'identity', level: 'basic' },
          risk: 'routine',
          selectors: [],
        },
        accessKind: 'detail',
        entrypoint: defineSystemModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'protected' },
          entrypointKey: key,
          moduleKey: 'core.shell',
          role,
        }),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: `${key}.evidence.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'optional',
        owningModuleKey: 'core.shell',
        policies: [],
        readKey: key,
        resultSchema: Schema.String,
        schemaVersion: '1',
      },
      () =>
        Effect.sync(() => {
          onLoad();
          return { evidence: { resultCount: 1 }, result: key };
        }),
      () => Effect.succeed({}),
    );
  return {
    composition: make('core.shell.composition', 'api'),
    moduleTarget: make('core.shell.module-target', 'api'),
    resourceDetail: make('core.shell.resource-detail-timeline', 'api'),
    search: make('core.shell.search', 'search'),
    tenantModuleTarget: make('core.shell.tenant-module-target', 'api'),
  };
};

it.layer(NodeCrypto.layer)('read test harness', (suite) => {
  suite.effect('forwards the five captured Shell reads and admits only the exact tenant-module-target definition', () =>
    Effect.gen(function* registeredShellReadHarness() {
      const snapshot = yield* makeApplicationCompositionSnapshotFixture();
      for (const control of [
        'allowed',
        'denied',
        'unavailable',
        'recreated',
        'four-fields',
        'wrong-fifth',
        'extra-field',
        'wrong-build',
      ] as const) {
        let calls = 0;
        const definitions = shellDefinitions(() => {
          calls += 1;
        });
        const recreated = shellDefinitions(() => {
          calls += 1;
        });
        let selected = definitions;
        if (control === 'four-fields') {
          selected = new Proxy(definitions, {
            ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== 'tenantModuleTarget'),
          });
        } else if (control === 'wrong-fifth') {
          selected = { ...definitions, tenantModuleTarget: definitions.moduleTarget };
        } else if (control === 'extra-field') {
          const extra = { ...definitions, extra: definitions.tenantModuleTarget };
          selected = extra;
        }
        const harness = yield* makeReadTestHarness({
          access: control === 'denied' || control === 'unavailable' ? control : 'allowed',
          applicationComposition: { load: Effect.succeed(snapshot) },
          compositionRevision: snapshot.composition.revision,
          executeOwnerQuery: () => Effect.die('The Shell definition does not query owner SQL'),
          expectedDeployment:
            control === 'wrong-build'
              ? { ...snapshot.composition.shell.deployment, buildMarker: 'unapproved-shell-build' }
              : snapshot.composition.shell.deployment,
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          scope,
          shellSystemReads: selected,
        });
        const result = harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: control === 'recreated' ? recreated.tenantModuleTarget : definitions.tenantModuleTarget,
          transport: { correlationId: scope.correlationId },
        });
        if (control === 'allowed') {
          expect(yield* result).toBe('core.shell.tenant-module-target');
          expect(calls).toBe(1);
          expect(harness.snapshot().evidenceWrites).toBe(1);
        } else {
          const failure = yield* result.pipe(Effect.flip);
          let expectedFailure = 'ReadHandlerUnavailable';
          if (control === 'denied') {
            expectedFailure = 'ReadPermissionDenied';
          } else if (control === 'unavailable') {
            expectedFailure = 'ReadPermissionUnavailable';
          }
          expect(failure._tag).toBe(expectedFailure);
          expect(calls).toBe(0);
        }
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }
    }),
  );

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
      // Allowed evidence runs in its own scoped transaction after the owner transaction commits, so no
      // connection idles while the evidence transaction is opened.
      const { statements } = harness.snapshot();
      const ownerCommitIndex = statements.indexOf('COMMIT');
      const evidenceIndex = statements.findIndex((statement) => statement.includes('data_access_events'));
      expect(ownerCommitIndex).toBeGreaterThan(-1);
      expect(evidenceIndex).toBeGreaterThan(ownerCommitIndex);
      expect(statements.slice(ownerCommitIndex + 1, evidenceIndex)).toContain('BEGIN');
      expect(statements.at(-2)).toContain('data_access_events');
      expect(statements.at(-1)).toBe('COMMIT');
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

  suite.effect('admits composed reads through the publication fence before scoped owner SQL', () =>
    Effect.gen(function* composedReadLifecycle() {
      const harness = yield* makeReadTestHarness({
        compositionRevision,
        executeOwnerQuery: (query) => {
          expect(query.sql).toContain('from "core"."tenants"');
          expect(query.sql).toContain('transaction_timestamp()');
          expect(query.sql).not.toContain('publication_lock');
          expect(query.scope).toEqual({ legalEntityId: '', tenantId: scope.tenantId });
          return Effect.succeed([{ tenantId: scope.tenantId }]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        permissionDecision: 'allowed',
        scope: composedScope,
      });
      expect(yield* harness.runtime.runRead(composedInvocation)).toEqual([scope.tenantId]);
      const { evidenceWrites, ownerQueries, stages, statements } = harness.snapshot();
      expect(ownerQueries).toHaveLength(1);
      const fenceIndex = statements.findIndex((statement) => statement.includes('as publication_lock'));
      expect(fenceIndex).toBeGreaterThan(-1);
      expect(statements[fenceIndex]).toContain("current_setting('transaction_isolation')");
      expect(statements[fenceIndex]).toContain('pg_advisory_xact_lock_shared');
      expect(statements[fenceIndex]).not.toContain('from "core"."application_composition_authority"');
      expect(statements[fenceIndex + 1]).toContain('from "core"."application_composition_authority"');
      const ownerIndex = statements.indexOf(ownerQueries[0]?.sql ?? '');
      const scopeIndex = statements.findIndex((statement) => statement.includes('set_config'));
      expect(scopeIndex).toBeGreaterThan(fenceIndex + 1);
      expect(ownerIndex).toBeGreaterThan(scopeIndex);
      // The scope install reads back the connected role in the same statement; no separate verification read.
      expect(statements[scopeIndex]).toBe(
        "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id",
      );
      expect(statements.slice(scopeIndex + 1, ownerIndex)).toEqual(['select transaction_timestamp() as operation_at']);
      expect(statements[ownerIndex + 1]).toBe('COMMIT');
      expect(statements.some((statement) => statement.includes('SAVEPOINT'))).toBe(false);
      expect(evidenceWrites).toBe(1);
      expect(stages.slice(-3)).toEqual(['handler_executed', 'result_decoded', 'evidence_persisted']);
      const evidenceIndex = statements.findIndex((statement) => statement.includes('data_access_events'));
      expect(evidenceIndex).toBeGreaterThan(ownerIndex + 1);
      expect(
        statements.slice(ownerIndex + 1, evidenceIndex).some((statement) => statement.includes('set_config')),
      ).toBe(true);
      expect(statements.at(-1)).toBe('COMMIT');
    }),
  );

  suite.effect('does not treat composed owner SQL containing transaction time as infrastructure', () =>
    Effect.gen(function* composedOwnerOutage() {
      const harness = yield* makeReadTestHarness({
        compositionRevision,
        executeOwnerQuery: (query) => {
          expect(query.sql).toContain('from "core"."tenants"');
          expect(query.sql).toContain('transaction_timestamp()');
          expect(query.scope).toEqual({ legalEntityId: '', tenantId: scope.tenantId });
          return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled owner outage' }) }));
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        permissionDecision: 'allowed',
        scope: composedScope,
      });
      const failure = yield* harness.runtime.runRead(composedInvocation).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().evidenceWrites).toBe(0);
      expect(harness.snapshot().stages).toContain('scope_installed');
      expect(harness.snapshot().stages).not.toContain('handler_executed');
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

  suite.effect('uses the supplied gate instead of a scripted allow', () =>
    Effect.gen(function* suppliedGateDenial() {
      const gate = makeScriptedBoundAccessGate('denied');
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        accessDecision: gate.bound,
        executeOwnerQuery: () => Effect.die('A denied read must not query its owner'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration,
        scope,
      });
      const failure = yield* harness.runtime.runRead(protectedInvocation).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toHaveLength(0);
    }),
  );

  suite.effect('admits scope when only a supplied gate answers access', () =>
    Effect.gen(function* suppliedGateScopeAdmission() {
      const harness = yield* makeReadTestHarness({
        accessDecision: makeScriptedBoundAccessGate('allowed').bound,
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
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

const fencedReadScenarios = [
  {
    databaseIdentities: defineDatabaseIdentityEnrollment([]),
    name: 'session settings',
    principal: trustVerifiedGatewayPrincipalContext(scope, compositionRevision),
  },
  {
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    name: 'registered gateway grant',
    principal: trustVerifiedGatewayPrincipalContext(scope, compositionRevision, {
      assertion: Redacted.make('read-harness-registered-scope'),
      audience: FIXTURE_DESCRIPTOR.request.gatewayScopeAudiences[0],
    }),
  },
];

it.layer(NodeCrypto.layer)('read publication fencing', (suite) => {
  for (const scenario of fencedReadScenarios) {
    suite.effect(`keeps combined ${scenario.name} and publication fencing out of owner queries`, () =>
      Effect.gen(function* composedReadProtocol() {
        const harness = yield* makeReadTestHarness({
          compositionRevision,
          databaseIdentities: scenario.databaseIdentities,
          executeOwnerQuery: (query) => {
            expect(query.sql).toContain('from "core"."tenants"');
            expect(query.scope).toEqual({ legalEntityId: '', tenantId: scope.tenantId });
            return Effect.succeed([{ tenantId: scope.tenantId }]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration,
          permissionDecision: 'allowed',
          scope: scenario.principal,
        });
        expect(yield* harness.runtime.runRead({ ...invocation, principal: scenario.principal })).toEqual([
          scope.tenantId,
        ]);
        const snapshot = harness.snapshot();
        expect(snapshot.ownerQueries).toHaveLength(1);
        expect(snapshot.evidenceWrites).toBe(1);
        const fenceIndex = snapshot.statements.findIndex((statement) => statement.includes('as publication_lock'));
        expect(fenceIndex).toBeGreaterThan(-1);
        expect(snapshot.statements[fenceIndex]).toContain("current_setting('transaction_isolation') as isolation");
        expect(snapshot.statements[fenceIndex]).toContain('then pg_advisory_xact_lock_shared');
        const admissionIndex = snapshot.statements.findIndex(
          (statement, index) =>
            index > fenceIndex && statement.includes('from "core"."application_composition_authority"'),
        );
        const ownerIndex = snapshot.statements.findIndex((statement) => statement.includes('from "core"."tenants"'));
        expect(admissionIndex).toBeGreaterThan(fenceIndex);
        expect(ownerIndex).toBeGreaterThan(admissionIndex);
        expect(snapshot.stages.slice(-3)).toEqual(['handler_executed', 'result_decoded', 'evidence_persisted']);
      }),
    );
  }
});
