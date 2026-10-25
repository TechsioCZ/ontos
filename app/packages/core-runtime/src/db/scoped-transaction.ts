import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgPolicy } from 'drizzle-orm/pg-core';
import { Context, DateTime, Effect, Option, Predicate, Redacted } from 'effect';

import { readVerifiedGatewayScopeAssertion } from '../auth/system-principal-context-provenance.ts';
import type { GatewayScopeAssertion } from '../auth/system-principal-context-provenance.ts';
import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import { gatewayScopeGrantRoleForAudience } from './database-identities.ts';
import type { DatabaseIdentityEnrollment, DatabaseScopeAuthority } from './database-identities.ts';
import { scopedRoutineInvokerFromTransaction } from './scoped-routine.ts';
import type { ScopedRoutineInvoker } from './scoped-routine.ts';
import type { CoreTransaction } from './types.ts';

const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');
type ScopedRoutineRawRow = Record<string, never>;
type OperationalScopeRawTransaction = Pick<CoreTransaction, 'delete' | 'execute' | 'insert' | 'select' | 'update'>;

/** Private owner-factory capability. It is never supplied to an Action or read handler. */
export interface ScopedTransactionExecutor extends ScopedRoutineInvoker {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  /** Core-installed scope snapshot; owner readers bind their predicates to this transaction. */
  readonly scope: Readonly<Pick<OperationalScope, 'tenantId' | 'legalEntityId'>>;
  readonly [scopedTransaction]: true;
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
}

interface SettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string;
  readonly tenant_id: string;
}

export interface OperationalScopeTransactionService {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  readonly install: (scope: OperationalScope) => Effect.Effect<void, OperationContextUnavailable>;
  readonly scopedRoutineInvoker: (scope: OperationalScope) => ScopedRoutineInvoker;
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
  readonly verify: Effect.Effect<Option.Option<SettingRow>, OperationContextUnavailable>;
}

export class OperationalScopeTransaction extends Context.Service<
  OperationalScopeTransaction,
  OperationalScopeTransactionService
>()('@app/core-runtime/db/scoped-transaction/OperationalScopeTransaction') {}

const operationContextUnavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The database operation scope could not be installed',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

interface OperationalScopeAuthority {
  readonly install: (scope: OperationalScope) => Effect.Effect<void, OperationContextUnavailable>;
  readonly verify: Effect.Effect<Option.Option<SettingRow>, OperationContextUnavailable>;
}

interface ScopeVerificationRow extends SettingRow {
  readonly role: string;
}

const scopeAuthorityForRole = (enrollment: DatabaseIdentityEnrollment, role: string): DatabaseScopeAuthority =>
  enrollment.identities.find((candidate) => candidate.role === role)?.scopeAuthority ?? 'none';

const readSettingRow = (statement: SQL, transaction: OperationalScopeRawTransaction) =>
  transaction.execute<SettingRow>(statement, 'objects').pipe(
    Effect.mapError(operationContextUnavailable),
    Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
  );

/**
 * Reads the installed scope together with the connected role. The scope counts only when that role's
 * database identity installs scope through `authority`; a gateway-grant role never trusts session
 * settings, and a role without scope authority never trusts either. Logins outside the runtime
 * identities are not granted implicit session-setting authority.
 */
const readVerifiedScope = (
  statement: SQL,
  transaction: OperationalScopeRawTransaction,
  authority: Exclude<DatabaseScopeAuthority, 'none'>,
  enrollment: DatabaseIdentityEnrollment,
  expectedRole?: string,
) =>
  transaction.execute<ScopeVerificationRow>(statement, 'objects').pipe(
    Effect.mapError(operationContextUnavailable),
    Effect.flatMap(([row]) => {
      if (row === undefined) {
        return Effect.succeed(Option.none<SettingRow>());
      }
      return scopeAuthorityForRole(enrollment, row.role) === authority &&
        (expectedRole === undefined || row.role === expectedRole)
        ? Effect.succeedSome<SettingRow>({ legal_entity_id: row.legal_entity_id, tenant_id: row.tenant_id })
        : Effect.fail(operationContextUnavailable());
    }),
  );

/** Session-setting authority used by the shared runtime and worker roles. */
const sessionSettingScopeAuthority = (
  transaction: OperationalScopeRawTransaction,
  enrollment: DatabaseIdentityEnrollment,
): OperationalScopeAuthority => ({
  install: (scope) =>
    transaction
      .execute(
        sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
        'objects',
      )
      .pipe(Effect.mapError(operationContextUnavailable), Effect.asVoid),
  verify: readVerifiedScope(
    sql`
      select
        current_user::text as role,
        current_setting('ontos.tenant_id', true) as tenant_id,
        current_setting('ontos.legal_entity_id', true) as legal_entity_id
    `,
    transaction,
    'session_setting',
    enrollment,
  ),
});

/** Establishes the gateway-grant scope and returns the tenant and legal entity the database derived. */
export const establishGatewayScopeStatement = (assertion: Redacted.Redacted): SQL =>
  sql`select established_tenant_id::text as tenant_id, coalesce(established_legal_entity_id::text, '') as legal_entity_id from trust.establish_gateway_scope(${Redacted.value(assertion)})`;

/**
 * Gateway-grant authority: the database derives the scope from the redeemed assertion that Shell
 * registered, so the request role never chooses its own tenant.
 */
const gatewayGrantScopeAuthority = (
  transaction: OperationalScopeRawTransaction,
  scopeAssertion: GatewayScopeAssertion,
  enrollment: DatabaseIdentityEnrollment,
  expectedRole: string,
): OperationalScopeAuthority => ({
  install: () =>
    readSettingRow(establishGatewayScopeStatement(scopeAssertion.assertion), transaction).pipe(Effect.asVoid),
  verify: readVerifiedScope(
    sql`select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id`,
    transaction,
    'gateway_grant',
    enrollment,
    expectedRole,
  ),
});

const installedScopeMatches = (installed: SettingRow, scope: OperationalScope) =>
  installed.tenant_id === scope.tenantId && installed.legal_entity_id === (scope.legalEntityId ?? '');

const scopedTransactionExecutor = (
  transaction: Pick<CoreTransaction, 'delete' | 'insert' | 'select' | 'update'>,
  routineInvoker: ScopedRoutineInvoker,
  scope: OperationalScope,
): ScopedTransactionExecutor =>
  Object.freeze({
    delete: transaction.delete.bind(transaction),
    insert: transaction.insert.bind(transaction),
    invoke: routineInvoker.invoke,
    scope: Object.freeze(
      scope.legalEntityId === undefined
        ? { tenantId: scope.tenantId }
        : { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
    ),
    [scopedTransaction]: true as const,
    select: transaction.select.bind(transaction),
    update: transaction.update.bind(transaction),
  });

const operationalScopeAuthority = (
  transaction: OperationalScopeRawTransaction,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
): OperationalScopeAuthority => {
  const scopeAssertion = readVerifiedGatewayScopeAssertion(scope);
  const expectedRole =
    scopeAssertion === undefined
      ? Option.none<string>()
      : gatewayScopeGrantRoleForAudience(enrollment, scopeAssertion.audience);
  return scopeAssertion !== undefined && Option.isSome(expectedRole)
    ? gatewayGrantScopeAuthority(transaction, scopeAssertion, enrollment, expectedRole.value)
    : sessionSettingScopeAuthority(transaction, enrollment);
};

const operationalScopeTransactionFromCoreTransaction = (
  transaction: OperationalScopeRawTransaction,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
): OperationalScopeTransactionService => {
  const authority = operationalScopeAuthority(transaction, scope, enrollment);
  return {
    delete: transaction.delete.bind(transaction),
    insert: transaction.insert.bind(transaction),
    install: authority.install,
    scopedRoutineInvoker: (routineScope) =>
      scopedRoutineInvokerFromTransaction(
        (statement) => transaction.execute<ScopedRoutineRawRow>(statement, 'objects'),
        routineScope,
      ),
    select: transaction.select.bind(transaction),
    update: transaction.update.bind(transaction),
    verify: authority.verify,
  };
};

export const installOperationalScopeFromTransactionService = Effect.fn('installOperationalScopeFromTransactionService')(
  function* installOperationalScopeFromTransactionServiceEffect(scope: OperationalScope) {
    const transaction = yield* OperationalScopeTransaction;
    yield* transaction.install(scope);
    const setting = yield* transaction.verify;
    if (Option.isNone(setting) || !installedScopeMatches(setting.value, scope)) {
      return yield* operationContextUnavailable();
    }
    return scopedTransactionExecutor(transaction, transaction.scopedRoutineInvoker(scope), scope);
  },
);

interface InstalledScopeRow extends ScopeVerificationRow {
  readonly isolation?: string;
  readonly operation_at: unknown;
}

/**
 * Installs scope and reads the transaction's trusted start time. Session-setting roles share one
 * statement; gateway-grant roles first establish scope from the sealed assertion, then verify the
 * database-derived scope in a later statement. Both paths verify the connected role's authority.
 */
export const installOperationalScopeAt = Effect.fn('installOperationalScopeAt')(
  function* installOperationalScopeAtEffect(
    transaction: OperationalScopeRawTransaction,
    scope: OperationalScope,
    enrollment: DatabaseIdentityEnrollment,
    lock?: { readonly acquire: SQL; readonly isolation: 'read committed' },
  ) {
    const scopeAssertion = readVerifiedGatewayScopeAssertion(scope);
    const expectedRole =
      scopeAssertion === undefined
        ? Option.none<string>()
        : gatewayScopeGrantRoleForAudience(enrollment, scopeAssertion.audience);
    const gatewayGrant = scopeAssertion !== undefined && Option.isSome(expectedRole);
    if (scopeAssertion !== undefined && Option.isSome(expectedRole)) {
      yield* gatewayGrantScopeAuthority(transaction, scopeAssertion, enrollment, expectedRole.value).install(scope);
    }
    // Infrastructure locks may share scope installation, but any protected data read must use a later
    // statement: READ COMMITTED needs a new snapshot after a possible advisory-lock wait.
    const locking =
      lock === undefined
        ? sql``
        : sql`, current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = ${lock.isolation} then ${lock.acquire} end as publication_lock`;
    const [installed] = yield* transaction
      .execute<InstalledScopeRow>(
        gatewayGrant
          ? sql`select current_user::text as role, coalesce(trust.current_tenant_id()::text, '') as tenant_id, coalesce(trust.current_legal_entity_id()::text, '') as legal_entity_id, transaction_timestamp() as operation_at${locking}`
          : sql`select current_user::text as role, set_config('ontos.tenant_id', ${scope.tenantId}, true) as tenant_id, set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true) as legal_entity_id, transaction_timestamp() as operation_at${locking}`,
        'objects',
      )
      .pipe(Effect.mapError(operationContextUnavailable));
    if (
      installed === undefined ||
      scopeAuthorityForRole(enrollment, installed.role) !== (gatewayGrant ? 'gateway_grant' : 'session_setting') ||
      (Option.isSome(expectedRole) && installed.role !== expectedRole.value) ||
      !installedScopeMatches(installed, scope) ||
      (lock !== undefined && installed.isolation !== lock.isolation) ||
      !Predicate.isDate(installed.operation_at) ||
      !Number.isFinite(installed.operation_at.getTime())
    ) {
      return yield* operationContextUnavailable();
    }
    const routineInvoker = scopedRoutineInvokerFromTransaction(
      (statement) => transaction.execute<ScopedRoutineRawRow>(statement, 'objects'),
      scope,
    );
    return {
      operationAt: DateTime.fromDateUnsafe(installed.operation_at),
      scoped: scopedTransactionExecutor(transaction, routineInvoker, scope),
    };
  },
);

export const installOperationalScope = (
  transaction: OperationalScopeRawTransaction,
  scope: OperationalScope,
  enrollment: DatabaseIdentityEnrollment,
): Effect.Effect<ScopedTransactionExecutor, OperationContextUnavailable> =>
  installOperationalScopeFromTransactionService(scope).pipe(
    Effect.updateContext((context: Context.Context<never>) =>
      Context.add(
        context,
        OperationalScopeTransaction,
        operationalScopeTransactionFromCoreTransaction(transaction, scope, enrollment),
      ),
    ),
  );

const operationalRlsPolicies = (prefix: string, predicate: SQL, role: string) =>
  [
    pgPolicy(`${prefix}_select`, {
      for: 'select',
      to: role,
      using: predicate,
    }),
    pgPolicy(`${prefix}_insert`, {
      for: 'insert',
      to: role,
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: role,
      using: predicate,
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_delete`, {
      for: 'delete',
      to: role,
      using: predicate,
    }),
  ] as const;

const sessionTenantPredicate = (tenantColumn: AnyPgColumn) =>
  sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;

const sessionTenantLegalEntityPredicate = (tenantColumn: AnyPgColumn, legalEntityColumn: AnyPgColumn) =>
  sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${legalEntityColumn} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;

const gatewayTenantPredicate = (tenantColumn: AnyPgColumn) => sql`${tenantColumn} = (select trust.current_tenant_id())`;

const gatewayTenantLegalEntityPredicate = (tenantColumn: AnyPgColumn, legalEntityColumn: AnyPgColumn) =>
  sql`${tenantColumn} = (select trust.current_tenant_id()) and ((select trust.current_legal_entity_id()) is null or ${legalEntityColumn} is null or ${legalEntityColumn} = (select trust.current_legal_entity_id()))`;

export const tenantRlsPolicies = (prefix: string, tenantColumn: AnyPgColumn) =>
  operationalRlsPolicies(prefix, sessionTenantPredicate(tenantColumn), 'ontos_runtime');

export const tenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
) =>
  operationalRlsPolicies(prefix, sessionTenantLegalEntityPredicate(tenantColumn, legalEntityColumn), 'ontos_runtime');

/** Tenant policies for a request role whose scope comes only from a registered gateway grant. */
export const gatewayScopedTenantRlsPolicies = (prefix: string, tenantColumn: AnyPgColumn, role: string) =>
  operationalRlsPolicies(prefix, gatewayTenantPredicate(tenantColumn), role);

/** Tenant and legal-entity policies for a request role whose scope comes only from a gateway grant. */
export const gatewayScopedTenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
  role: string,
) => operationalRlsPolicies(prefix, gatewayTenantLegalEntityPredicate(tenantColumn, legalEntityColumn), role);

/** Read-only tenant policy for a worker role that installs scope through session settings. */
export const sessionScopedTenantReadRlsPolicy = (prefix: string, tenantColumn: AnyPgColumn, role: string) =>
  pgPolicy(`${prefix}_worker_select`, {
    for: 'select',
    to: role,
    using: sessionTenantPredicate(tenantColumn),
  });

/** Read-only tenant and legal-entity policy for a worker role that installs scope through session settings. */
export const sessionScopedTenantLegalEntityReadRlsPolicy = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
  role: string,
) =>
  pgPolicy(`${prefix}_worker_select`, {
    for: 'select',
    to: role,
    using: sessionTenantLegalEntityPredicate(tenantColumn, legalEntityColumn),
  });
