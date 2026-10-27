import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_DESCRIPTOR } from '../support/database-identities.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { tenants } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadServiceFactory } from '../../src/reads/definition.ts';
import type { ReadLoadContext } from '../../src/reads/context.ts';
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
      entrypointKey: 'commerce.inventory.read-harness',
      moduleKey: 'commerce.inventory',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'commerce.inventory.read-harness.evidence' },
    inputSchema: Schema.Struct({}),
    legalEntityScope: 'forbidden',
    owningModuleKey: 'commerce.inventory',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'commerce.inventory.read-harness',
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
const invocation = { input: {}, principal: scope, registration, transport: { correlationId: scope.correlationId } };

it.layer(NodeCrypto.layer)('read test harness', (suite) => {
  suite.effect('defaults permission to denied before owner SQL and persists denied evidence', () =>
    Effect.gen(function* defaultDenied() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Owner SQL must not run'),
        operationTime,
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
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime.runRead(invocation).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(harness.snapshot().evidenceWrites).toBe(0);
      expect(harness.snapshot().statements.at(-1)).toBe('ROLLBACK');
    }),
  );
});

const compositionRevision = 'a'.repeat(64);
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
