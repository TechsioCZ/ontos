import { and, eq, sql } from 'drizzle-orm';
import { Effect, Layer, Option } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import type { PrincipalStatus } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import { principals } from '../db/schema.ts';
import { PrincipalEligibility } from './principal-ref.ts';
import type { PrincipalEligibilityService, PrincipalRef } from './principal-ref.ts';

export interface PrincipalEligibilityRecord {
  readonly status: PrincipalStatus;
  readonly tenantId: string;
}

/** Narrow persistence port used to verify eligibility behavior without forging database clients. */
export interface PrincipalEligibilityPersistence<PersistenceError> {
  readonly loadPrincipal: (
    principal: PrincipalRef,
  ) => Effect.Effect<readonly PrincipalEligibilityRecord[], PersistenceError>;
}

export const makePrincipalEligibility = <PersistenceError>(
  persistence: PrincipalEligibilityPersistence<PersistenceError>,
): PrincipalEligibilityService =>
  Object.freeze({
    resolve: Effect.fn('PrincipalEligibility.resolve')(function* resolvePrincipalEligibility(principal: PrincipalRef) {
      const rowsOption = yield* persistence.loadPrincipal(principal).pipe(Effect.option);
      if (Option.isNone(rowsOption)) {
        return { decision: 'unavailable', principal, reason: 'indeterminate' } as const;
      }
      const [row] = rowsOption.value;
      if (row === undefined) {
        return { decision: 'ineligible', principal, reason: 'missing' } as const;
      }
      if (rowsOption.value.length !== 1 || row.tenantId !== principal.tenantId) {
        return { decision: 'ineligible', principal, reason: 'tenant_mismatch' } as const;
      }
      return row.status === 'active'
        ? ({ decision: 'eligible', principal, reason: 'active' } as const)
        : ({ decision: 'ineligible', principal, reason: 'inactive' } as const);
    }),
  });

/**
 * Core-owned Principal eligibility adapter for an already scoped operation transaction.
 * Owner factories receive only the typed result service; Principal storage remains Core-private.
 */
export const principalEligibilityForTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'select'>,
): PrincipalEligibilityService =>
  makePrincipalEligibility({
    loadPrincipal: (principal) =>
      transaction
        .select({ status: principals.status, tenantId: principals.tenantId })
        .from(principals)
        .where(and(eq(principals.tenantId, principal.tenantId), eq(principals.principalId, principal.principalId)))
        .limit(2),
  });

interface OperationScopeSettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string | null;
  readonly tenant_id: string | null;
}

const readOperationScopeSettings = sql`
  select
    current_setting('ontos.tenant_id', true) as tenant_id,
    current_setting('ontos.legal_entity_id', true) as legal_entity_id
`;

const installOperationScopeSettings = (tenantId: string, legalEntityId: string) =>
  sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;

/**
 * The eligibility read is Tenant scoped, so it installs its own Tenant and an empty Legal Entity.
 * When a caller is already inside an operation transaction this one is a savepoint on that same
 * connection, and a released savepoint keeps its transaction-local settings — so the caller's own
 * operation scope is captured first and restored afterwards. Without that, an Action transaction
 * would continue with an empty `ontos.legal_entity_id` and its owner routines would refuse the very
 * scope Core verified for them.
 */
const loadPrincipalInOwnScope = Effect.fn('PrincipalEligibility.loadPrincipal')(function* loadPrincipalEffect(
  transaction: CoreTransaction,
  principal: PrincipalRef,
) {
  const callerScope = yield* transaction.execute<OperationScopeSettingRow>(readOperationScopeSettings, 'objects');
  yield* transaction.execute(installOperationScopeSettings(principal.tenantId, ''));
  const rows = yield* transaction
    .select({ status: principals.status, tenantId: principals.tenantId })
    .from(principals)
    .where(and(eq(principals.tenantId, principal.tenantId), eq(principals.principalId, principal.principalId)))
    .limit(2);
  yield* transaction.execute(
    installOperationScopeSettings(callerScope[0]?.tenant_id ?? '', callerScope[0]?.legal_entity_id ?? ''),
  );
  return rows;
});

/** Core-owned production service; callers receive decisions, never a database capability. */
export const PrincipalEligibilityLive = Layer.effect(
  PrincipalEligibility,
  CoreDatabase.pipe(
    Effect.map((database) =>
      makePrincipalEligibility({
        loadPrincipal: (principal) =>
          database.executor.transaction((transaction) => loadPrincipalInOwnScope(transaction, principal)),
      }),
    ),
  ),
);
