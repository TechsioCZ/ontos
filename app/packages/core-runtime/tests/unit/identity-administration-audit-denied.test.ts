import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UniqueViolation } from 'effect/unstable/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  IdentityAdministrationDeniedAttemptSchema,
  IdentityAdministrationDeniedAudit,
  IdentityAdministrationDeniedAuditLive,
  identityAdministrationDeniedAuditRow,
} from '../../src/auth/identity-administration-audit-denied.ts';
import { IdentityAdministrationDeniedAuditUnavailable } from '../../src/auth/identity-administration-audit-unavailable.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { OperationalScopeResolver } from '../../src/operations/context.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestDatabase } from '../support/database.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

const principalId = '30000000-0000-4000-8000-000000000001';
const targetPrincipalId = '30000000-0000-4000-8000-000000000002';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const transport = { correlationId: 'original-denied-request', traceId: 'original-trace' };
const principalEffect = Schema.decodeEffect(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:original-denied-request',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
const attempt = { operation: 'configure-agent', principalKind: 'agent', targetPrincipalId } as const;

it('accepts only real bounded operations with matching subject kind and valid optional target IDs', () => {
  const decode = Schema.decodeUnknownOption(IdentityAdministrationDeniedAttemptSchema, { onExcessProperty: 'error' });
  for (const operation of ['create-agent', 'configure-agent', 'change-status-agent', 'delete-agent']) {
    expect(Option.isSome(decode({ ...attempt, operation }))).toBe(true);
  }
  for (const operation of ['create', 'change-role', 'change-status']) {
    expect(Option.isSome(decode({ ...attempt, operation, principalKind: null }))).toBe(true);
  }
  for (const invalid of [
    { ...attempt, operation: 'arbitrary-event' },
    { ...attempt, operation: 'configure-agent', principalKind: null },
    { ...attempt, operation: 'change-role' },
    { ...attempt, targetPrincipalId: 'foreign-unvalidated-id' },
    { ...attempt, outcome: 'succeeded' },
    { ...attempt, token: 'not-evidence' },
    { ...attempt, tenantId },
  ]) {
    expect(Option.isNone(decode(invalid))).toBe(true);
  }
});

it.effect('fixes denial evidence and preserves the real original caller, binding, company and transport', () =>
  Effect.gen(function* retainedDenial() {
    const principal = yield* principalEffect;
    const scope = yield* testOperationalScopeResolver.resolve({
      ...transport,
      legalEntityScope: 'required',
      principal,
    });
    const decodedAttempt = yield* Schema.decodeEffect(IdentityAdministrationDeniedAttemptSchema)(attempt);
    const row = identityAdministrationDeniedAuditRow(scope, decodedAttempt);
    expect(row).toMatchObject({
      auditProfile: 'sensitive',
      authBindingId: principal.authBindingId,
      authContextRef: principal.authContextRef,
      authMethod: 'session',
      eventType: 'action.rejected',
      legalEntityId,
      outcome: 'denied',
      outcomeCode: 'company_administrator_required',
      outcomeStage: 'authz',
      principalId,
      tenantId,
    });
    expect(row.evidenceJson).toEqual({
      actionKey: 'core.identity.manage-demo-account',
      ...transport,
      ...attempt,
      reason: 'company_administrator_required',
    });
    expect(row).not.toHaveProperty('occurredAt');
    expect(row).not.toHaveProperty('actionInvocationId');
  }),
);

for (const failInsert of [false, true]) {
  it.effect(
    `native denied observer ${failInsert ? 'propagates persistence failure with its cause' : 'commits fixed evidence without Action authority'}`,
    () =>
      Effect.gen(function* nativeObserver() {
        const principal = yield* principalEffect;
        const statements: string[] = [];
        const sqlFailure = new SqlError({
          reason: new UniqueViolation({
            cause: { code: '23505', constraint: 'test_audit_failure' },
            constraint: 'test_audit_failure',
          }),
        });
        let inserted = 0;
        const executor = yield* makeTestDatabase((statement, params) => {
          statements.push(statement);
          const text = statement.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
          if (/^(?:begin|commit|rollback)(?:\s|$)/u.test(text)) {
            return Effect.succeed([]);
          }
          if (text.startsWith("select set_config('ontos.tenant_id'")) {
            expect(params).toEqual([tenantId, legalEntityId]);
            return Effect.succeed([]);
          }
          if (text.startsWith('select current_user::text as role')) {
            return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
          }
          expect(text).toMatch(/^insert into "core"\."audit_events"/u);
          expect(params).toContain(principalId);
          expect(params).toContain(principal.authBindingId);
          expect(params).toContain(principal.authContextRef);
          expect(params).toContain(tenantId);
          expect(params).toContain(legalEntityId);
          expect(params).toContain('sensitive');
          expect(params).toContain('action.rejected');
          expect(params).toContain('company_administrator_required');
          expect(params).toContain('authz');
          expect(params.some(Schema.is(Schema.Date))).toBe(false);
          expect(params).toContain(
            JSON.stringify({
              actionKey: 'core.identity.manage-demo-account',
              correlationId: transport.correlationId,
              operation: attempt.operation,
              principalKind: attempt.principalKind,
              reason: 'company_administrator_required',
              targetPrincipalId,
              traceId: transport.traceId,
            }),
          );
          inserted += 1;
          return failInsert ? Effect.fail(sqlFailure) : Effect.succeed([]);
        });
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('Observer must not run a Read or Action'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          scope: { ...principal, ...transport },
        });
        // Existing explicit downstream-of-admission fixture; production uses the actual native resolver Layer.
        const services = yield* Layer.build(
          IdentityAdministrationDeniedAuditLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                harness.layer,
                Layer.succeed(CoreDatabase, { executor }),
                Layer.succeed(OperationalScopeResolver, testOperationalScopeResolver),
              ),
            ),
          ),
        );
        const record = Context.get(services, IdentityAdministrationDeniedAudit).record({
          principal,
          transport: { ...transport, idempotencyKey: 'original-denied-action' },
          ...attempt,
        });
        if (failInsert) {
          const failure = yield* record.pipe(Effect.flip);
          expect(failure).toBeInstanceOf(IdentityAdministrationDeniedAuditUnavailable);
          expect(Option.getOrThrow(findPostgresFailure(failure.cause))).toEqual({
            code: '23505',
            constraint: 'test_audit_failure',
          });
          expect(statements.some((statement) => statement.toLowerCase().startsWith('rollback'))).toBe(true);
          expect(statements.some((statement) => statement.toLowerCase().startsWith('commit'))).toBe(false);
        } else {
          yield* record;
          expect(statements.some((statement) => statement.toLowerCase().startsWith('commit'))).toBe(true);
        }
        expect(inserted).toBe(1);
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
  );
}

it.effect('an allowed administrator cannot manufacture a denied observation and no SQL is opened', () =>
  Effect.gen(function* noManufacturedDenial() {
    const principal = yield* principalEffect;
    const executor = yield* makeTestDatabase(() => Effect.die('Unproven denial opened SQL'));
    const harness = yield* makeReadTestHarness({
      executeOwnerQuery: () => Effect.die('Unexpected owner query'),
      operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      permissionDecision: 'allowed',
      scope: { ...principal, ...transport },
    });
    const services = yield* Layer.build(
      IdentityAdministrationDeniedAuditLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.layer,
            Layer.succeed(CoreDatabase, { executor }),
            Layer.succeed(OperationalScopeResolver, testOperationalScopeResolver),
          ),
        ),
      ),
    );
    const failure = yield* Context.get(services, IdentityAdministrationDeniedAudit)
      .record({ principal, transport, ...attempt })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(IdentityAdministrationDeniedAuditUnavailable);
  }),
);
