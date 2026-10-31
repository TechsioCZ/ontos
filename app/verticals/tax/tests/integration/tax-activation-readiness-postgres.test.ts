import { NodeCrypto } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, Layer, Match, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  DeclareSellerVatRegimePayloadSchema,
  ImportSellerVatRegimeDeclarationsPayloadSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import { TaxActivationItemIdSchema } from '../../shared/domain/tax-activation-contracts.ts';
import { taxRelations, taxSellerVatRegimeDeclarations } from '../../src/database/schema.ts';
import { TAX_ACTIVATION_ITEMS, assessTaxActivationReadiness } from '../../src/domain/tax-activation-readiness.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const ACTIVATION_AT = DateTime.makeUnsafe('2026-06-01T00:00:00.000Z');

interface FixtureIdentity {
  readonly principalId: string;
  readonly tenantId: string;
}

const scopeFor = (identity: FixtureIdentity, legalEntityId: string) =>
  Effect.gen(function* makeActivationScope() {
    const [authContextId, correlationId] = yield* Effect.all([nextUuid, nextUuid]);
    const scope: OperationalScope = {
      authContextRef: `better-auth-session:${authContextId}`,
      authMethod: 'session',
      correlationId,
      legalEntityId,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    };
    return scope;
  });

type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const runScoped = <Value, Failure>(
  database: CoreTestDatabase,
  scope: OperationalScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runTaxOwnerScopedOperation() {
      const scopedTransaction = yield* installOperationalScope(
        transaction,
        scope,
        FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      );
      return yield* operation(scopedTransaction);
    }),
  );

const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope) =>
  nextUuid.pipe(
    Effect.map((actionInvocationId) => ({
      actionInvocationId,
      actorPrincipalId: scope.principalId,
      legalEntityId: scope.legalEntityId ?? '',
      operationTime,
      tenantId: scope.tenantId,
    })),
  );

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>, tenantId: string) =>
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
  const [tenantId, principalId] = yield* Effect.all([nextUuid, nextUuid]);
  yield* cleanup(admin, tenantId);
  yield* Effect.addFinalizer(() => cleanup(admin, tenantId).pipe(Effect.orDie));
  return { identity: { principalId, tenantId }, runtime };
});

/** One seller whose declarations go through the same owner service the declare Action uses. */
const seller = Effect.fnUntraced(function* makeSeller(runtime: CoreTestDatabase, identity: FixtureIdentity) {
  const legalEntityId = yield* nextUuid;
  const scope = yield* scopeFor(identity, legalEntityId);
  const declare = Effect.fnUntraced(function* declareAction(regime: 'NON_PAYER' | 'VAT_PAYER', effectiveFrom: string) {
    const payload = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom,
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared regime for the activation fixture',
      regime,
    });
    const actionInvocation = yield* invocation(scope);
    return yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).declare({ ...payload, ...actionInvocation }),
    );
  });
  /** The seller's existing source declaration, imported once with no merchant confirmation (907-Q08). */
  const importDeclarations = Effect.fnUntraced(function* importDeclarationsAction(
    input: typeof ImportSellerVatRegimeDeclarationsPayloadSchema.Encoded,
  ) {
    const payload = yield* Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(input);
    const actionInvocation = yield* invocation(scope);
    return yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).importDeclarations({
        ...payload,
        ...actionInvocation,
      }),
    );
  });
  /** The public Seller VAT Regime history read, in this seller's own scope. */
  const history = runScoped(runtime, scope, (transaction) =>
    sellerVatRegimeDeclarationsForScope(transaction, scope).history.pipe(
      Effect.map(Option.map((declarations) => ({ history: declarations, sellingLegalEntityRef: legalEntityId }))),
    ),
  );
  return { declare, history, importDeclarations, legalEntityId };
});

// Each test stays a live registration against real PostgreSQL and builds Node Crypto in its scope.
const nodeCrypto = Layer.build(NodeCrypto.layer).pipe(Effect.map((context) => Context.get(context, Crypto.Crypto)));

it.live('#964 patched F25 the activation gate reads each seller’s persisted declaration timeline', () =>
  Effect.scoped(
    Effect.gen(function* activationGateAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const payer = yield* seller(runtime, identity);
      const laterNonPayer = yield* seller(runtime, identity);
      const undeclared = yield* seller(runtime, identity);
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
            tenantRef: identity.tenantId,
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
        atActivation: {
          declarationRevisionRef: { revision: 1 },
          provenance: 'MERCHANT_DECLARED',
          regime: 'VAT_PAYER',
        },
        payerDicRequired: true,
      });
      expect(readiness.activationClaim).toBe('NONE');
      expect(readiness.evidenceLabel).toBe('NON_PRODUCTION');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live(
  '907-Q09 #964 a seller covered only by an imported MIGRATED declaration is not blocked on the declaration item',
  () =>
    Effect.scoped(
      Effect.gen(function* migratedActivationAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const migratedNonPayer = yield* seller(runtime, identity);
        const migratedPayer = yield* seller(runtime, identity);
        // Current-only source state: covered from the migration start, which is before activation.
        yield* migratedNonPayer.importDeclarations({
          declarations: [{ regime: 'NON_PAYER', sourceRecordRef: 'legacy:non-payer' }],
          migrationRunRef: 'migration-run-1',
          migrationStartedAt: '2026-03-01T00:00:00.000Z',
        });
        yield* migratedPayer.importDeclarations({
          declarations: [
            { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
          ],
          migrationRunRef: 'migration-run-1',
          migrationStartedAt: '2026-03-01T00:00:00.000Z',
        });

        const sellerDeclarations = (yield* Effect.all([migratedNonPayer.history, migratedPayer.history])).flatMap(
          Option.toArray,
        );
        const resolvedItems = TaxActivationItemIdSchema.literals
          .filter((itemId) => TAX_ACTIVATION_ITEMS[itemId].scope === 'ACTIVATION')
          .map((itemId) => ({ evidenceRef: `evidence:${itemId}`, itemId }));
        const readiness = Result.getOrThrow(
          assessTaxActivationReadiness({
            resolvedItems,
            scope: {
              activationAt: ACTIVATION_AT,
              sellingLegalEntityRefs: [migratedNonPayer.legalEntityId, migratedPayer.legalEntityId],
              tenantRef: identity.tenantId,
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
        // Only the payer's own Billing DIČ item stays open (907-Q10); provenance never blocks the declaration item.
        expect(blockers).toEqual([['BILLING_PAYER_DIC_GATE', migratedPayer.legalEntityId]]);
        expect(
          readiness.sellers.map(({ atActivation, sellingLegalEntityRef }) => [sellingLegalEntityRef, atActivation]),
        ).toEqual(
          expect.arrayContaining([
            [
              migratedNonPayer.legalEntityId,
              expect.objectContaining({
                effectiveFromOrigin: 'MIGRATION_START',
                provenance: 'MIGRATED',
                regime: 'NON_PAYER',
              }),
            ],
            [
              migratedPayer.legalEntityId,
              expect.objectContaining({ effectiveFromOrigin: 'SOURCE', provenance: 'MIGRATED', regime: 'VAT_PAYER' }),
            ],
          ]),
        );
        expect(readiness.activationClaim).toBe('NONE');
        expect(readiness.evidenceLabel).toBe('NON_PRODUCTION');
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);
