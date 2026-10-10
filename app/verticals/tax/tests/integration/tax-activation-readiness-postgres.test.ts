import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { DeclareSellerVatRegimePayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import { TaxActivationItemIdSchema } from '../../shared/domain/tax-activation-contracts.ts';
import { taxRelations, taxSellerVatRegimeDeclarations } from '../../src/database/schema.ts';
import { TAX_ACTIVATION_ITEMS, assessTaxActivationReadiness } from '../../src/domain/tax-activation-readiness.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const ACTIVATION_AT = DateTime.makeUnsafe('2026-06-01T00:00:00.000Z');

const scopeFor = (legalEntityId: string): OperationalScope => ({
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId,
});

type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const runScoped = <Value, Failure>(
  database: CoreTestDatabase,
  scope: OperationalScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runTaxOwnerScopedOperation() {
      const scopedTransaction = yield* installOperationalScope(transaction, scope);
      return yield* operation(scopedTransaction);
    }),
  );

const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupActivationDeclarationRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireActivationTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { runtime };
});

/** One seller whose declarations go through the same owner service the declare Action uses. */
const seller = (runtime: CoreTestDatabase) => {
  const legalEntityId = randomUUID();
  const scope = scopeFor(legalEntityId);
  const declare = (regime: 'NON_PAYER' | 'VAT_PAYER', effectiveFrom: string) =>
    Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom,
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared regime for the activation fixture',
      regime,
    }).pipe(
      Effect.flatMap((payload) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).declare({ ...payload, ...invocation(scope) }),
        ),
      ),
    );
  /** The public Seller VAT Regime history read, in this seller's own scope. */
  const history = runScoped(runtime, scope, (transaction) =>
    sellerVatRegimeDeclarationsForScope(transaction, scope).history.pipe(
      Effect.map(Option.map((declarations) => ({ history: declarations, sellingLegalEntityRef: legalEntityId }))),
    ),
  );
  return { declare, history, legalEntityId };
};

it.live('#964 patched F25 the activation gate reads each seller’s persisted declaration timeline', () =>
  Effect.scoped(
    Effect.gen(function* activationGateAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const payer = seller(runtime);
      const laterNonPayer = seller(runtime);
      const undeclared = seller(runtime);
      yield* payer.declare('VAT_PAYER', '2026-01-01T00:00:00.000Z');
      yield* laterNonPayer.declare('NON_PAYER', '2026-09-01T00:00:00.000Z');

      const sellerDeclarations = (yield* Effect.all([
        payer.history,
        laterNonPayer.history,
        undeclared.history,
      ])).flatMap(Option.toArray);
      const resolvedItems = TaxActivationItemIdSchema.literals
        .filter((itemId) => TAX_ACTIVATION_ITEMS[itemId].scope === 'ACTIVATION')
        .map((itemId) => ({ evidenceRef: `evidence:${itemId}`, itemId }));
      const readiness = Result.getOrThrow(
        assessTaxActivationReadiness({
          resolvedItems,
          scope: {
            activationAt: ACTIVATION_AT,
            sellingLegalEntityRefs: [payer.legalEntityId, laterNonPayer.legalEntityId, undeclared.legalEntityId],
            tenantRef: tenantId,
          },
          sellerDeclarations,
        }),
      );

      const blockers = Match.value(readiness.verdict).pipe(
        Match.tag('NOT_READY', ({ blockers: open }) =>
          open.map(({ itemId, sellingLegalEntityRef }) => [itemId, sellingLegalEntityRef]),
        ),
        Match.tag('READY', () => []),
        Match.exhaustive,
      );
      // The payer needs its Billing DIČ item; the later non-payer and the undeclared seller are not covered.
      const uncovered = [laterNonPayer.legalEntityId, undeclared.legalEntityId]
        .toSorted((left, right) => (left < right ? -1 : 1))
        .map((ref) => ['SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION', ref]);
      expect(blockers).toEqual([...uncovered, ['BILLING_PAYER_DIC_GATE', payer.legalEntityId]]);
      expect(
        readiness.sellers.find(({ sellingLegalEntityRef }) => sellingLegalEntityRef === payer.legalEntityId),
      ).toMatchObject({
        atActivation: { declarationRevisionRef: { revision: 1 }, provenance: 'MERCHANT_DECLARED', regime: 'VAT_PAYER' },
        payerDicRequired: true,
      });
      expect(readiness.activationClaim).toBe('NONE');
      expect(readiness.evidenceLabel).toBe('NON_PRODUCTION');
    }),
  ),
);
