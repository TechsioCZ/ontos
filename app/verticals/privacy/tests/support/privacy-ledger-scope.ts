import { DatabaseConfigLive, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CoreDatabase, CoreDatabaseLive } from '@app/core-runtime/testing/owner-evidence';
import { Crypto, Effect, Layer, Schema } from 'effect';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';

/**
 * A fresh, isolated Tenant/Legal Entity/Principal scope for a suite that proves Privacy against its REAL ledgers in a
 * local PostgreSQL, through the owner's own repositories and Core's own operational-scope installer (row-level
 * security applies). It deliberately does not claim authorization: the governed access gate is a different seam, and
 * this harness needs no SpiceDB. Every row it writes belongs to its random Tenant, so suites never collide.
 */
export const freshPrivacyLedgerScope = Effect.fn('PrivacyTests.freshLedgerScope')(function* freshLedgerScope() {
  const crypto = yield* Crypto.Crypto;
  const [tenantId, legalEntityId, principalId, authBindingId] = yield* Effect.all(
    [crypto.randomUUIDv4(), crypto.randomUUIDv4(), crypto.randomUUIDv4(), crypto.randomUUIDv4()],
    { concurrency: 1 },
  );
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: `fixture:privacy-ledger:${principalId}`,
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  });
  return { ...principal, correlationId: `fixture:privacy-ledger:${tenantId}` };
});

export type PrivacyLedgerScope = Effect.Success<ReturnType<typeof freshPrivacyLedgerScope>>;

/** Runs `body` inside ONE real transaction whose operational scope is installed exactly as Core installs it. */
export const inPrivacyLedger = <Value, Failure, Requirements>(
  scope: PrivacyLedgerScope,
  body: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.flatMap(Effect.service(CoreDatabase), (database) =>
    database.executor.transaction((transaction) => Effect.flatMap(installOperationalScope(transaction, scope), body)),
  );

/** The runtime-role database of the isolated local PostgreSQL named by the shell environment. */
export const privacyLedgerDatabaseLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
