import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { TestClock } from 'effect/testing';

import type { MembershipRow } from '../../src/access/intent/memberships.ts';
import { acceptPersonInvitationFromTransaction } from '../../src/auth/person-invitation-acceptance.ts';
import { IdentityTargetInvalidError } from '../../src/auth/principal-management-errors.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import { personInvitations, principalCompanyMemberships } from '../../src/db/schema.ts';
import type { CompanyMembershipStatus } from '../../src/permissions/company-membership.ts';
import { makeTestDatabase } from '../support/database.ts';

const uid = (value: number) => `75000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const companyId = uid(2);
const principalId = uid(3);
const inviterId = uid(4);
const invitationId = uid(5);
const invocationId = uid(6);
const tenantScopeId = uid(7);
const companyScopeId = uid(8);
const authBindingId = uid(9);
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z'));
const before = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T11:00:00.000Z'));
const after = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T13:00:00.000Z'));
const providerSubjectId = 'invited-provider-subject';
const verificationId = 'invited-verification';
const issuedEvidence = {
  actionKey: 'core.identity.invite-person',
  affiliation: 'external',
  displayName: 'Invited person',
  email: 'invited@example.org',
  invitationId,
  legalEntityId: companyId,
  membershipRevision: 1,
  membershipStatus: 'invited',
  principalRef: { principalId, tenantId },
};
const tenantScope = { legalEntityId: null, scopeId: tenantScopeId, tenantContextId: tenantId };
const accessScopes = [tenantScope, { legalEntityId: companyId, scopeId: companyScopeId, tenantContextId: null }];

interface Statement {
  readonly params: readonly unknown[];
  readonly sql: string;
}
interface FixtureOptions {
  readonly authorityPresent?: boolean;
  readonly bindingInvocation?: string | null;
  readonly credentialFailure?: boolean;
  readonly directoryStatus?: CompanyMembershipStatus;
  readonly evidence?: object;
  readonly expiresAt?: Date;
  readonly failTable?: string;
  readonly invitationPresent?: boolean;
  readonly memberships?: readonly MembershipRow[];
  readonly originalInvocationPresent?: boolean;
  readonly originalPrincipalId?: string | null;
  readonly scopes?: typeof accessScopes;
}

const membership = (overrides: Partial<MembershipRow> = {}): MembershipRow => ({
  agentId: null,
  createdAt: before,
  kind: 'member',
  membershipId: uid(20),
  principalId,
  recordedBy: inviterId,
  scopeId: tenantScopeId,
  status: 'active',
  tenantId,
  validFrom: before,
  validUntil: null,
  ...overrides,
});

/** SELECT * follows the actual table's column order, independently of object authoring order. */
type InvitationRow = typeof personInvitations.$inferSelect;
type CompanyMembershipRow = typeof principalCompanyMemberships.$inferSelect;
type InvitationSqlValue = InvitationRow[keyof InvitationRow] | CompanyMembershipRow[keyof CompanyMembershipRow];
const tableRow = (table: PgTable, row: Readonly<Record<string, InvitationSqlValue>>) =>
  Object.fromEntries(Object.keys(getTableColumns(table)).map((column) => [column, row[column]]));

const selectedRows = (statement: string, options: FixtureOptions): readonly object[] | undefined => {
  if (statement.includes('from "core"."principal_auth_bindings"')) {
    return [
      {
        authBindingId,
        legalEntityId: companyId,
        originatorInvocationId: options.bindingInvocation === undefined ? invocationId : options.bindingInvocation,
        principalId,
        tenantId,
      },
    ];
  }
  if (statement.includes('from "core"."person_invitations"')) {
    return options.invitationPresent === false
      ? []
      : [
          tableRow(personInvitations, {
            createdAt: before,
            expiresAt: options.expiresAt ?? after,
            invitationId,
            legalEntityId: companyId,
            principalId,
            providerSubjectId,
            tenantId,
            verificationId,
          }),
        ];
  }
  if (statement.includes('from "core"."application_composition_authority"')) {
    if (statement.includes('"phase"')) {
      return [{ phase: 'active', revision: 'approved-fixture', subscriptionsJson: null, unexpired: true }];
    }
    return options.authorityPresent === false ? [] : [{ revision: 'approved-fixture' }];
  }
  if (statement.includes('from "core"."principal_company_memberships"')) {
    return [
      tableRow(principalCompanyMemberships, {
        affiliation: 'external',
        createdAt: before,
        legalEntityId: companyId,
        principalId,
        revision: 1,
        status: options.directoryStatus ?? 'invited',
        tenantId,
        updatedAt: before,
      }),
    ];
  }
  if (statement.includes('from "core"."action_invocations"')) {
    return options.originalInvocationPresent === false
      ? []
      : [
          {
            evidence: options.evidence ?? issuedEvidence,
            principalId: options.originalPrincipalId === undefined ? inviterId : options.originalPrincipalId,
          },
        ];
  }
  if (statement.includes('from "core"."access_scopes"')) {
    return options.scopes ?? accessScopes;
  }
  if (statement.includes('from "core"."access_memberships"')) {
    return options.memberships ?? [];
  }
  if (statement.includes('from "core"."principals"')) {
    return [{ companyStatus: 'active', kind: 'human', principalStatus: 'active', tenantStatus: 'active' }];
  }
  return undefined;
};

/**
 * The real Effect SQL transaction and Drizzle queries run over a scripted connection. This proves
 * statement attribution and COMMIT/ROLLBACK boundaries without a database URL or a synthetic scope.
 * Shell's owned native credential test proves the corresponding PostgreSQL row rollback.
 */
const acceptance = (options: FixtureOptions = {}) =>
  Effect.gen(function* runAcceptance() {
    yield* TestClock.setTime(at.getTime());
    const statements: Statement[] = [];
    const query = (statement: string, params: readonly unknown[]): Effect.Effect<readonly object[], SqlError> => {
      statements.push({ params, sql: statement });
      if (
        (statement.startsWith('insert into') && statement.includes(`"${options.failTable ?? 'no-failure'}"`)) ||
        (options.credentialFailure === true && statement.includes('credential-write'))
      ) {
        return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'owned transaction failure' }) }));
      }
      if (statement.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed', publication_lock: null }]);
      }
      const rows = selectedRows(statement, options);
      if (rows !== undefined) {
        return Effect.succeed(rows);
      }
      if (statement.startsWith('update "core"."principal_company_memberships"')) {
        return Effect.succeed([{ affiliation: 'external', revision: 2, status: 'active' }]);
      }
      if (statement.startsWith('insert into "core"."domain_events"')) {
        return Effect.succeed([{ domainEventId: uid(10) }]);
      }
      return Effect.succeed([]);
    };
    const database = yield* makeTestDatabase(query);
    const result = yield* Effect.exit(
      database.transaction((transaction) =>
        acceptPersonInvitationFromTransaction(transaction, {
          expiresAt: after,
          providerSubjectId,
          verificationId,
        }).pipe(
          Effect.andThen(
            options.credentialFailure === true
              ? transaction.execute(sql`select 'credential-write'`, 'objects').pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
    );
    return { result, statements };
  });

const insertFor = (statements: readonly Statement[], table: string) =>
  statements.filter((statement) => statement.sql.startsWith(`insert into "core"."${table}"`));
const expectNoRights = (statements: readonly Statement[]) => {
  for (const table of [
    'access_roles',
    'access_role_revisions',
    'access_assignments',
    'access_delegations',
    'access_team_members',
  ]) {
    expect(insertFor(statements, table)).toEqual([]);
  }
};
const expectRefused = (result: Exit.Exit<void, unknown>, statements: readonly Statement[]) => {
  expect(Exit.isFailure(result)).toBe(true);
  expect(Schema.is(IdentityTargetInvalidError)(Option.getOrUndefined(Exit.findErrorOption(result)))).toBe(true);
  expect(statements.some((statement) => statement.sql === 'ROLLBACK')).toBe(true);
  expect(statements.some((statement) => statement.sql === 'COMMIT')).toBe(false);
  expect(insertFor(statements, 'audit_events')).toEqual([]);
  expect(insertFor(statements, 'outbox_messages')).toEqual([]);
  expectNoRights(statements);
};

it.effect(
  'commits canonical tenant and exact company participation with original inviter provenance, never rights',
  () =>
    Effect.gen(function* admitsExactMembership() {
      const { result, statements } = yield* acceptance();
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toBe(true);
      const [write] = insertFor(statements, 'access_memberships');
      expect(write).toBeDefined();
      expect(insertFor(statements, 'access_memberships')).toHaveLength(1);
      expect(write?.params.filter((value) => value === 'member')).toHaveLength(2);
      expect(write?.params.filter((value) => value === inviterId)).toHaveLength(2);
      expect(write?.params.filter((value) => value === principalId)).toHaveLength(2);
      expect(write?.params).toContain(tenantScopeId);
      expect(write?.params).toContain(companyScopeId);
      const source = statements.find((statement) => statement.sql.includes('from "core"."action_invocations"'));
      expect(source?.params).toEqual([
        'action.executed',
        'succeeded',
        tenantId,
        companyId,
        invocationId,
        'core.identity.invite-person',
        'succeeded',
      ]);
      expect(source?.sql).toContain('"completed_at" is not null');
      expect(source?.sql).toContain('"audit_events"."principal_id" = "core"."action_invocations"."principal_id"');
      const [event] = insertFor(statements, 'domain_events');
      expect(event?.params).toContain(invocationId);
      const [audit] = insertFor(statements, 'audit_events');
      expect(audit?.params).toContain(principalId);
      expect(audit?.params).not.toContain(inviterId);
      expect(
        audit?.params.some((value) => Schema.is(Schema.String)(value) && value.includes(`"invitedBy":"${inviterId}"`)),
      ).toBe(true);
      expect(insertFor(statements, 'outbox_messages')).toHaveLength(1);
      expect(statements.some((statement) => statement.sql === 'COMMIT')).toBe(true);
      expectNoRights(statements);
      const bindingQuery = statements.find((statement) =>
        statement.sql.includes('from "core"."principal_auth_bindings"'),
      );
      expect(bindingQuery?.params).toContain(STAFF_AUTHENTICATION_NAMESPACE_ID);
      expect(bindingQuery?.params).toContain(providerSubjectId);
      expect(bindingQuery?.sql).toContain('"revoked_at" is null');
    }),
);

it.effect('preserves an existing live tenant membership deadline and admits only the exact company', () =>
  Effect.gen(function* preservesLiveDeadline() {
    const { result, statements } = yield* acceptance({ memberships: [membership({ validUntil: after })] });
    expect(Exit.isSuccess(result)).toBe(true);
    const [write] = insertFor(statements, 'access_memberships');
    expect(write?.params.filter((value) => value === 'member')).toHaveLength(1);
    expect(write?.params).toContain(companyScopeId);
    expect(write?.params).not.toContain(tenantScopeId);
    expect(statements.some((statement) => statement.sql.startsWith('update "core"."access_memberships"'))).toBe(false);
  }),
);

it.effect('does not duplicate admission, audit or wakeups after this invitation was already accepted', () =>
  Effect.gen(function* acceptedIsNoOp() {
    const { result, statements } = yield* acceptance({ directoryStatus: 'active' });
    expect(Exit.isSuccess(result)).toBe(true);
    expect(insertFor(statements, 'access_memberships')).toEqual([]);
    expect(insertFor(statements, 'audit_events')).toEqual([]);
    expect(insertFor(statements, 'outbox_messages')).toEqual([]);
  }),
);

for (const directoryStatus of ['disabled', 'departed'] as const) {
  it.effect(`does not revive a ${directoryStatus} company invitation`, () =>
    Effect.gen(function* refusedDirectoryState() {
      const { result, statements } = yield* acceptance({ directoryStatus });
      expectRefused(result, statements);
      expect(insertFor(statements, 'access_memberships')).toEqual([]);
    }),
  );
}

for (const overrides of [
  { status: 'suspended' },
  { status: 'revoked' },
  { validFrom: after },
  { validUntil: at },
] satisfies readonly Partial<MembershipRow>[]) {
  it.effect(`refuses prior canonical membership ${overrides.status ?? Object.keys(overrides)[0]} without revival`, () =>
    Effect.gen(function* refusedExistingMembership() {
      const { result, statements } = yield* acceptance({ memberships: [membership(overrides)] });
      expectRefused(result, statements);
      expect(insertFor(statements, 'access_memberships')).toEqual([]);
    }),
  );
}

for (const options of [
  { bindingInvocation: null },
  { originalInvocationPresent: false },
  { originalPrincipalId: null },
  { evidence: {} },
  { evidence: { ...issuedEvidence, actionKey: 'core.identity.other-action' } },
  { evidence: { ...issuedEvidence, invitationId: uid(90) } },
  { evidence: { ...issuedEvidence, legalEntityId: uid(91) } },
  { evidence: { ...issuedEvidence, principalRef: { principalId, tenantId: uid(92) } } },
  { evidence: { ...issuedEvidence, principalRef: { principalId: uid(93), tenantId } } },
  { evidence: { ...issuedEvidence, affiliation: 'employee' } },
] satisfies readonly FixtureOptions[]) {
  it.effect(`fails closed for incomplete or foreign issued-invitation proof ${JSON.stringify(options)}`, () =>
    Effect.gen(function* refusedOriginalInvitation() {
      const { result, statements } = yield* acceptance(options);
      expectRefused(result, statements);
      expect(insertFor(statements, 'access_memberships')).toEqual([]);
    }),
  );
}

for (const options of [
  { scopes: [] },
  { scopes: [tenantScope] },
  { scopes: [tenantScope, { legalEntityId: uid(99), scopeId: companyScopeId, tenantContextId: null }] },
  { authorityPresent: false },
  { expiresAt: before },
] satisfies readonly FixtureOptions[]) {
  it.effect(`refuses missing, foreign or stale admission scope ${JSON.stringify(options)}`, () =>
    Effect.gen(function* refusedScope() {
      const { result, statements } = yield* acceptance(options);
      expectRefused(result, statements);
      expect(insertFor(statements, 'access_memberships')).toEqual([]);
    }),
  );
}

for (const failTable of ['access_memberships', 'audit_events', 'domain_events', 'outbox_messages']) {
  it.effect(`rolls back the native acceptance transaction when ${failTable} persistence fails`, () =>
    Effect.gen(function* bridgeFailureRollsBack() {
      const { result, statements } = yield* acceptance({ failTable });
      expect(Exit.isFailure(result)).toBe(true);
      expect(statements.some((statement) => statement.sql === 'ROLLBACK')).toBe(true);
      expect(statements.some((statement) => statement.sql === 'COMMIT')).toBe(false);
      expectNoRights(statements);
    }),
  );
}

it.effect('keeps admission, acceptance audit and wakeup inside the credential transaction rollback boundary', () =>
  Effect.gen(function* credentialFailureRollsBack() {
    const { result, statements } = yield* acceptance({ credentialFailure: true });
    expect(Exit.isFailure(result)).toBe(true);
    expect(insertFor(statements, 'access_memberships')).toHaveLength(1);
    expect(insertFor(statements, 'audit_events')).toHaveLength(1);
    expect(insertFor(statements, 'outbox_messages')).toHaveLength(1);
    expect(statements.at(-1)?.sql).toBe('ROLLBACK');
    expect(statements.some((statement) => statement.sql === 'COMMIT')).toBe(false);
    expect(statements.some((statement) => statement.sql.includes('SAVEPOINT'))).toBe(false);
  }),
);

it.effect('ignores ordinary password reset consumption with no matching invitation intent', () =>
  Effect.gen(function* ordinaryResetIsNotAnInvitation() {
    const { result, statements } = yield* acceptance({ invitationPresent: false });
    expect(Exit.isSuccess(result)).toBe(true);
    expect(insertFor(statements, 'access_memberships')).toEqual([]);
    expect(insertFor(statements, 'audit_events')).toEqual([]);
    expect(statements.some((statement) => statement.sql.includes('from "core"."action_invocations"'))).toBe(false);
  }),
);
