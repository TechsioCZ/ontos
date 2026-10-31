import { PgDialect, getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import {
  OperationalScopeTransaction,
  gatewayScopedTenantLegalEntityRlsPolicies,
  gatewayScopedTenantRlsPolicies,
  installOperationalScope,
  installOperationalScopeAt,
  installOperationalScopeFromTransactionService,
  sessionScopedTenantLegalEntityReadRlsPolicy,
  sessionScopedTenantReadRlsPolicy,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '../../src/db/scoped-transaction.ts';
import type { OperationalScopeTransactionService } from '../../src/db/scoped-transaction.ts';
import type { ScopedRoutineInvoker } from '../../src/db/scoped-routine.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_DESCRIPTOR } from '../support/database-identities.ts';

const unusedOperation = (): never => {
  throw new Error('CRUD operations are not used by this test');
};
const unusedRoutineInvoker = (): ScopedRoutineInvoker => ({ invoke: unusedOperation });
const transactionService = (
  install: OperationalScopeTransactionService['install'],
  verify: OperationalScopeTransactionService['verify'],
): OperationalScopeTransactionService => ({
  delete: unusedOperation,
  insert: unusedOperation,
  install,
  scopedRoutineInvoker: unusedRoutineInvoker,
  select: unusedOperation,
  update: unusedOperation,
  verify,
});
const principalId = '10000000-0000-4000-8000-000000000001';
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const transactionScope = (withLegalEntity: boolean) => {
  const context = withLegalEntity
    ? Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:scoped-transaction',
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      })
    : Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:scoped-transaction',
        authMethod: 'session',
        principalId,
        tenantId,
      });
  return { ...context, correlationId: 'c-1' };
};
it.effect('installs and verifies transaction-local scope and exposes no transaction controls', () =>
  Effect.gen(function* migratedTest1() {
    let calls = 0;
    const transaction = transactionService(
      () =>
        Effect.sync(() => {
          calls += 1;
        }),
      Effect.sync(() => {
        calls += 1;
        return Option.some({
          legal_entity_id: legalEntityId,
          tenant_id: tenantId,
        });
      }),
    );
    const capability = yield* installOperationalScopeFromTransactionService(transactionScope(true)).pipe(
      Effect.provideService(OperationalScopeTransaction, transaction),
    );
    expect(calls).toBe(2);
    expect('commit' in capability).toBe(false);
    expect('query' in capability).toBe(false);
    expect('rollback' in capability).toBe(false);
    expect('transaction' in capability).toBe(false);
    expect('invoke' in capability).toBe(true);
  }),
);
it.effect('fails closed when transaction settings do not match', () =>
  Effect.gen(function* migratedTest2() {
    const transaction = transactionService(
      () => Effect.void,
      Effect.succeedSome({ legal_entity_id: '', tenant_id: 'foreign' }),
    );
    const error = yield* Effect.flip(
      installOperationalScopeFromTransactionService(transactionScope(false)).pipe(
        Effect.provideService(OperationalScopeTransaction, transaction),
      ),
    );
    expect(Predicate.isTagged(error, 'OperationContextUnavailable')).toBe(true);
  }),
);
it('creates complete CRUD RLS policies with update using and with-check predicates', () => {
  const fixture = pgTable.withRLS('fixture', {
    legalEntityId: uuid('legal_entity_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  });
  expect(getTableConfig(fixture).enableRLS).toBe(true);
  for (const policies of [
    tenantRlsPolicies('tenant_fixture', fixture.tenantId),
    tenantLegalEntityRlsPolicies('entity_fixture', fixture.tenantId, fixture.legalEntityId),
  ]) {
    expect(policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(policies[2].using).toBeDefined();
    expect(policies[2].withCheck).toBeDefined();
  }
});

const assertionValue = 'eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0In0.c2lnbmF0dXJl';
const gatewayScope = (audience: string, withLegalEntity = false): OperationalScope =>
  trustVerifiedGatewayPrincipalContext(transactionScope(withLegalEntity), 'a'.repeat(64), {
    assertion: Redacted.make(assertionValue),
    audience,
  });

interface RecordedStatement {
  readonly params: readonly unknown[];
  readonly sql: string;
}

const isTransactionControl = (statement: string): boolean =>
  /^(?:begin|commit|rollback|start transaction)/iu.test(statement);

/** The tenant and legal entity a scripted scope statement reports back. */
interface ScopeSettingRow {
  readonly legal_entity_id: string;
  /** The connected role the verify statement reports. */
  readonly role: string;
  readonly tenant_id: string;
}

/** Runs `installOperationalScope` on a scripted transaction and records every scope statement. */
const recordScopeInstallation = (scope: OperationalScope, settingRow: ScopeSettingRow) =>
  Effect.gen(function* recordScopeInstallationEffect() {
    const statements: RecordedStatement[] = [];
    const database = yield* makeTestDatabase((statement, params) => {
      if (!isTransactionControl(statement)) {
        statements.push({ params, sql: statement });
      }
      return Effect.succeed([settingRow]);
    });
    const result = yield* Effect.exit(
      database.transaction((transaction) =>
        installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      ),
    );
    return { result, statements };
  });

it.effect('a redeemed party-registry assertion establishes the scope through the gateway grant', () =>
  Effect.gen(function* gatewayGrantInstallation() {
    const { result, statements } = yield* recordScopeInstallation(gatewayScope('party-registry'), {
      legal_entity_id: '',
      role: 'party_registry_runtime',
      tenant_id: tenantId,
    });
    expect(Exit.isSuccess(result)).toBe(true);
    expect(statements).toEqual([
      {
        params: [assertionValue],
        sql: "select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope($1)",
      },
      {
        params: [],
        sql: "select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id",
      },
    ]);
  }),
);

it.effect('a gateway grant whose derived scope differs from the request fails closed', () =>
  Effect.gen(function* gatewayGrantMismatch() {
    const foreignTenant = yield* recordScopeInstallation(gatewayScope('party-registry'), {
      legal_entity_id: '',
      role: 'party_registry_runtime',
      tenant_id: '20000000-0000-4000-8000-000000000002',
    });
    const missingLegalEntity = yield* recordScopeInstallation(gatewayScope('party-registry', true), {
      legal_entity_id: '',
      role: 'party_registry_runtime',
      tenant_id: tenantId,
    });
    for (const { result } of [foreignTenant, missingLegalEntity]) {
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Predicate.isTagged(Option.getOrThrow(Exit.findErrorOption(result)), 'OperationContextUnavailable')).toBe(
          true,
        );
      }
    }
  }),
);

it.effect('non-enrolled audiences and contexts without an assertion keep the session settings', () =>
  Effect.gen(function* sessionSettingInstallation() {
    for (const scope of [gatewayScope('catalog'), transactionScope(false)]) {
      const { result, statements } = yield* recordScopeInstallation(scope, {
        legal_entity_id: '',
        role: 'ontos_runtime',
        tenant_id: tenantId,
      });
      expect(Exit.isSuccess(result)).toBe(true);
      expect(statements.length).toBe(2);
      expect(statements[0]?.sql).toContain("set_config('ontos.tenant_id'");
      expect(statements[0]?.params).toEqual([tenantId, '']);
      expect(statements[1]?.sql).toContain("current_setting('ontos.tenant_id', true)");
      expect(statements.some(({ sql: statementSql }) => statementSql.includes('trust.'))).toBe(false);
      expect(statements.some(({ params }) => params.includes(assertionValue))).toBe(false);
    }
  }),
);

const expectOperationContextUnavailable = <A, E>(result: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    expect(Predicate.isTagged(Option.getOrThrow(Exit.findErrorOption(result)), 'OperationContextUnavailable')).toBe(
      true,
    );
  }
};

it.effect('a gateway-grant role never trusts session settings, even when they match the scope', () =>
  Effect.gen(function* gatewayRoleWithoutAssertion() {
    for (const scope of [transactionScope(false), gatewayScope('catalog')]) {
      const { result, statements } = yield* recordScopeInstallation(scope, {
        legal_entity_id: '',
        role: 'party_registry_runtime',
        tenant_id: tenantId,
      });
      expectOperationContextUnavailable(result);
      expect(statements.some(({ sql: statementSql }) => statementSql.includes('trust.'))).toBe(false);
    }
  }),
);

it.effect('a session-setting role cannot verify a gateway grant scope', () =>
  Effect.gen(function* sessionRoleWithAssertion() {
    const { result } = yield* recordScopeInstallation(gatewayScope('party-registry'), {
      legal_entity_id: '',
      role: 'ontos_runtime',
      tenant_id: tenantId,
    });
    expectOperationContextUnavailable(result);
  }),
);

const ledgerDescriptor = {
  moduleKey: 'ledger.owner',
  policyPrefix: 'ledger',
  request: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: ['ledger-api'],
    handlesBearerAssertions: true,
    id: 'ledger_request',
    ownerModuleKey: 'ledger.owner',
    registersGatewayScopeGrants: false,
    role: 'ledger_runtime',
    scopeAuthority: 'gateway_grant',
    urlKey: 'LEDGER_DATABASE_URL',
  },
  schemas: ['ledger_private'],
  worker: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [],
    handlesBearerAssertions: false,
    id: 'ledger_worker',
    ownerModuleKey: 'ledger.owner',
    registersGatewayScopeGrants: false,
    role: 'ledger_worker',
    scopeAuthority: 'session_setting',
    urlKey: 'LEDGER_WORKER_DATABASE_URL',
  },
} as const;

for (const installer of ['scope', 'timestamp'] as const) {
  for (const [audience, connectedRole] of [
    ['party-registry', 'ledger_runtime'],
    ['ledger-api', 'party_registry_runtime'],
  ] as const) {
    it.effect(`${installer} installation rejects ${connectedRole} for another owner's audience ${audience}`, () =>
      Effect.gen(function* crossAudienceRoleIsRejected() {
        const enrollment = defineDatabaseIdentityEnrollment([FIXTURE_DESCRIPTOR, ledgerDescriptor]);
        const statements: string[] = [];
        const scope = gatewayScope(audience);
        const database = yield* makeTestDatabase((statement) => {
          statements.push(statement);
          return Effect.succeed([
            {
              legal_entity_id: '',
              operation_at: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
              role: connectedRole,
              tenant_id: tenantId,
            },
          ]);
        });
        const result = yield* Effect.exit(
          database.transaction((transaction) =>
            installer === 'scope'
              ? installOperationalScope(transaction, scope, enrollment).pipe(Effect.asVoid)
              : installOperationalScopeAt(transaction, scope, enrollment).pipe(Effect.asVoid),
          ),
        );
        expectOperationContextUnavailable(result);
        expect(statements.some((statement) => statement.includes('trust.establish_gateway_scope'))).toBe(true);
        expect(statements.some((statement) => statement.includes('set_config'))).toBe(false);
        expect(statements.at(-1)).toBe('ROLLBACK');
      }),
    );
  }
}

it.effect('a role without operational scope authority fails closed', () =>
  Effect.gen(function* roleWithoutScopeAuthority() {
    const { result } = yield* recordScopeInstallation(transactionScope(false), {
      legal_entity_id: '',
      role: 'shell_gateway_issuer',
      tenant_id: tenantId,
    });
    expectOperationContextUnavailable(result);
  }),
);

it.effect('a login outside the enrolled identities cannot authorize domain SQL even with matching scope', () =>
  Effect.gen(function* unenrolledLoginHasNoScopeAuthority() {
    for (const installer of ['scope', 'timestamp'] as const) {
      const statements: RecordedStatement[] = [];
      const scope = transactionScope(true);
      const database = yield* makeTestDatabase((statement, params) => {
        statements.push({ params, sql: statement });
        return Effect.succeed([
          {
            legal_entity_id: scope.legalEntityId,
            operation_at: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            role: 'ontos_admin',
            tenant_id: scope.tenantId,
          },
        ]);
      });
      const result = yield* Effect.exit(
        database.transaction((transaction) =>
          Effect.gen(function* installBeforeDomainSql() {
            yield* installer === 'scope'
              ? installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT)
              : installOperationalScopeAt(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
            yield* transaction.execute(sql`select * from private_owner_data`, 'objects');
          }),
        ),
      );
      expectOperationContextUnavailable(result);
      expect(statements[0]?.sql).toBe('BEGIN');
      expect(statements[1]?.sql).toContain("set_config('ontos.tenant_id'");
      expect(statements[1]?.params).toEqual([scope.tenantId, scope.legalEntityId]);
      expect(statements.some(({ sql: statementSql }) => statementSql.includes('current_user::text as role'))).toBe(
        true,
      );
      expect(statements.some(({ sql: statementSql }) => statementSql.includes('private_owner_data'))).toBe(false);
      expect(statements).toHaveLength(installer === 'scope' ? 4 : 3);
      expect(statements.at(-1)?.sql).toBe('ROLLBACK');
    }
  }),
);

const renderPredicate = (predicate: SQL | undefined): string =>
  predicate === undefined ? '' : new PgDialect().sqlToQuery(predicate).sql;

it('renders gateway-grant and session read policies with their exact predicates and roles', () => {
  const fixture = pgTable.withRLS('fixture', {
    legalEntityId: uuid('legal_entity_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  });
  const gatewayTenant = gatewayScopedTenantRlsPolicies('gw', fixture.tenantId, 'party_registry_runtime');
  const gatewayLegalEntity = gatewayScopedTenantLegalEntityRlsPolicies(
    'gw_le',
    fixture.tenantId,
    fixture.legalEntityId,
    'party_registry_runtime',
  );
  const tenantPredicate = '"fixture"."tenant_id" = (select trust.current_tenant_id())';
  const legalEntityPredicate = `${tenantPredicate} and ((select trust.current_legal_entity_id()) is null or "fixture"."legal_entity_id" is null or "fixture"."legal_entity_id" = (select trust.current_legal_entity_id()))`;
  expect(gatewayTenant.map((policy) => policy.name)).toEqual(['gw_select', 'gw_insert', 'gw_update', 'gw_delete']);
  for (const [policies, predicate] of [
    [gatewayTenant, tenantPredicate],
    [gatewayLegalEntity, legalEntityPredicate],
  ] as const) {
    expect(policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(policies.map((policy) => policy.to)).toEqual(Array.from({ length: 4 }, () => 'party_registry_runtime'));
    expect(renderPredicate(policies[0].using)).toBe(predicate);
    expect(renderPredicate(policies[1].withCheck)).toBe(predicate);
    expect(renderPredicate(policies[2].using)).toBe(predicate);
    expect(renderPredicate(policies[2].withCheck)).toBe(predicate);
    expect(renderPredicate(policies[3].using)).toBe(predicate);
  }

  const sessionTenant = sessionScopedTenantReadRlsPolicy('worker_fixture', fixture.tenantId, 'party_registry_worker');
  const sessionLegalEntity = sessionScopedTenantLegalEntityReadRlsPolicy(
    'worker_le_fixture',
    fixture.tenantId,
    fixture.legalEntityId,
    'party_registry_worker',
  );
  const sessionTenantPredicate = `"fixture"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  expect(sessionTenant.name).toBe('worker_fixture_worker_select');
  expect(sessionTenant.for).toBe('select');
  expect(sessionTenant.to).toBe('party_registry_worker');
  expect(renderPredicate(sessionTenant.using)).toBe(sessionTenantPredicate);
  expect(sessionTenant.withCheck).toBeUndefined();
  expect(sessionLegalEntity.name).toBe('worker_le_fixture_worker_select');
  expect(sessionLegalEntity.to).toBe('party_registry_worker');
  expect(renderPredicate(sessionLegalEntity.using)).toBe(
    `${sessionTenantPredicate} and "fixture"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`,
  );
});
