import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Match, Option, Schema } from 'effect';
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
  DeclareSellerVatRegimeResultSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import { taxRelations, taxSellerVatRegimeDeclarations } from '../../src/database/schema.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';

const tenantId = randomUUID();
const principalId = randomUUID();

const scopeFor = (legalEntityId: string, tenant: string = tenantId): OperationalScope => ({
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId: tenant,
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

// Not backdated relative to `operationTime`, so no default `reason` is needed; a test that wants
// REASON_REQUIRED_FOR_BACKDATED_EFFECT overrides `effectiveFrom` to something strictly earlier.
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope, actionInvocationId: string = randomUUID(), at: Date = operationTime) => ({
  actionInvocationId,
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupSellerVatRegimeDeclarationRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireSellerVatRegimeTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { adminClient, runtime };
});

/** One seller, exercised through the same owner service the Action uses. */
const seller = (runtime: CoreTestDatabase, tenant: string = tenantId) => {
  const legalEntityId = randomUUID();
  const scope = scopeFor(legalEntityId, tenant);
  const declare = (
    overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {},
    actionInvocationId: string = randomUUID(),
  ) =>
    Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-02-01T00:00:00.000Z',
      expectedCurrentRevision: 0,
      regime: 'VAT_PAYER',
      ...overrides,
    }).pipe(
      Effect.flatMap((decoded) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
            ...decoded,
            ...invocation(scope, actionInvocationId),
          }),
        ),
      ),
    );
  const atInstant = (instant: string) =>
    runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).atInstant({
        instant: DateTime.makeUnsafe(instant),
      }),
    );
  const history = () =>
    runScoped(runtime, scope, (transaction) => sellerVatRegimeDeclarationsForScope(transaction, scope).history);
  return { atInstant, declare, history, legalEntityId, scope };
};

type DeclareOutcome = Effect.Success<ReturnType<ReturnType<typeof seller>['declare']>>;
const decodeDeclareResult = Schema.decodeUnknownSync(DeclareSellerVatRegimeResultSchema);

/** The typed result of an accepted/rejected declare; a governance conflict or stale basis fails the test. */
const resultOf = (outcome: DeclareOutcome) => {
  if ('kind' in outcome) {
    throw new Error(`Expected a declaration result, got ${outcome.kind}`);
  }
  return decodeDeclareResult(outcome.result);
};

/** The `DECLARED` branch of a declare result; any other tag fails the test. */
const declaredOf = (outcome: DeclareOutcome) =>
  Match.value(resultOf(outcome)).pipe(
    Match.tag('DECLARED', (declared) => declared),
    Match.tag('DECLARATION_REJECTED', ({ reason }) => {
      throw new Error(`Expected DECLARED, got DECLARATION_REJECTED(${reason})`);
    }),
    Match.exhaustive,
  );

/** The `DECLARATION_REJECTED` branch of a declare result; any other tag fails the test. */
const rejectedOf = (outcome: DeclareOutcome) =>
  Match.value(resultOf(outcome)).pipe(
    Match.tag('DECLARATION_REJECTED', (rejected) => rejected),
    Match.tag('DECLARED', () => {
      throw new Error('Expected DECLARATION_REJECTED, got DECLARED');
    }),
    Match.exhaustive,
  );

/** The regime of one DECLARED selection; any other tag fails the test. */
const regimeOf = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime),
    Match.tag('NOT_DECLARED', () => {
      throw new Error('Expected a DECLARED Seller VAT Regime selection');
    }),
    Match.exhaustive,
  );
const isNotDeclared = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('NOT_DECLARED', () => true),
    Match.tag('DECLARED', () => false),
    Match.exhaustive,
  );

it.live('#955 G a Core-invocation replay echoes the original result, including its replaced-revision refs', () =>
  Effect.scoped(
    Effect.gen(function* replayAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      const invocationId = randomUUID();

      const first = declaredOf(yield* subject.declare({ regime: 'VAT_PAYER' }, invocationId));
      expect(first.created).toBe(true);

      const replay = declaredOf(yield* subject.declare({ regime: 'VAT_PAYER' }, invocationId));
      expect(replay.created).toBe(false);
      expect(replay.declarationRef).toEqual(first.declarationRef);
      expect(replay.replacedScheduledRevisions).toEqual(first.replacedScheduledRevisions);

      // Same Core invocation id, different intent: idempotency reuse, never a second row.
      expect(yield* subject.declare({ regime: 'NON_PAYER' }, invocationId)).toEqual({
        conflict: 'IDEMPOTENCY_REUSED',
        kind: 'conflict',
      });
    }),
  ),
);

it.live('Unit 10 B CAS rejects a declare whose basis is already stale', () =>
  Effect.scoped(
    Effect.gen(function* staleBasisAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      expect(declaredOf(yield* subject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' })).revision).toBe(1);
      expect(yield* subject.declare({ expectedCurrentRevision: 0, regime: 'NON_PAYER' })).toEqual({
        kind: 'stale_basis',
      });
    }),
  ),
);

it.live('Unit 10 B a rejected backdated declare with no reason stores no row', () =>
  Effect.scoped(
    Effect.gen(function* rejectedStoresNothingAcceptance() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);

      const rejected = rejectedOf(
        yield* subject.declare({
          effectiveFrom: '2025-01-01T00:00:00.000Z',
          expectedCurrentRevision: 0,
          regime: 'VAT_PAYER',
        }),
      );
      expect(rejected.reason).toBe('REASON_REQUIRED_FOR_BACKDATED_EFFECT');
      const rows = yield* adminClient.unsafe(
        'select 1 from tax.tax_seller_vat_regime_declarations where tenant_id = $1 and legal_entity_id = $2',
        [tenantId, subject.legalEntityId],
      );
      expect(rows.length).toBe(0);
    }),
  ),
);

it.live(
  'Unit 10 B an earlier declare scheduled-confirms over a later live revision and persists the replaced ref',
  () =>
    Effect.scoped(
      Effect.gen(function* scheduledConfirmationAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        const scheduled = declaredOf(
          yield* subject.declare({ effectiveFrom: '2026-08-01T00:00:00.000Z', regime: 'NON_PAYER' }),
        );
        expect(scheduled.revision).toBe(1);

        // An earlier-effective declare without confirmation names the still-scheduled revision and stores nothing.
        const unconfirmed = rejectedOf(yield* subject.declare({ expectedCurrentRevision: 1, regime: 'VAT_PAYER' }));
        expect(unconfirmed.reason).toBe('SCHEDULED_REVISION_CONFIRMATION_REQUIRED');
        expect(unconfirmed.scheduledRevisions).toEqual([{ declarationRef: scheduled.declarationRef, revision: 1 }]);

        // Confirmed: the new declaration persists the replaced revision's own ref, never the new row's ref and
        // never the action invocation id (#943/#955 F-replay).
        const confirmed = declaredOf(
          yield* subject.declare({ confirmReplacesScheduled: true, expectedCurrentRevision: 1, regime: 'VAT_PAYER' }),
        );
        expect(confirmed.replacedScheduledRevisions).toEqual([
          { declarationRef: scheduled.declarationRef, revision: 1 },
        ]);
        expect(confirmed.replacedScheduledRevisions[0]?.declarationRef).not.toEqual(confirmed.declarationRef);

        // Replaying the confirming invocation reproduces the identical replaced-revision ref.
        const invocationId = randomUUID();
        const confirmOverrides = {
          confirmReplacesScheduled: true,
          effectiveFrom: '2026-03-01T00:00:00.000Z',
          expectedCurrentRevision: 2,
          regime: 'NON_PAYER',
        } as const;
        const originalInvocationConfirm = declaredOf(yield* subject.declare(confirmOverrides, invocationId));
        const replay = declaredOf(yield* subject.declare(confirmOverrides, invocationId));
        expect(replay.replacedScheduledRevisions).toEqual(originalInvocationConfirm.replacedScheduledRevisions);
      }),
    ),
);

it.live('Unit 10 B a rejected declare audits the seller scope reference, never the action invocation id', () =>
  Effect.scoped(
    Effect.gen(function* rejectionAuditResourceIdAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      const backdatedInvocationId = randomUUID();

      const backdatedOutcome = yield* subject.declare(
        {
          effectiveFrom: '2025-01-01T00:00:00.000Z',
          expectedCurrentRevision: 0,
          regime: 'VAT_PAYER',
        },
        backdatedInvocationId,
      );
      if ('kind' in backdatedOutcome) {
        throw new Error(`Expected a declaration outcome, got ${backdatedOutcome.kind}`);
      }
      // No declaration row exists for a rejection: the audited resource is the seller (Selling Legal Entity)
      // scope reference, never the action invocation id (#950 F45-F47 resourceId must name a real resource).
      expect(backdatedOutcome.audit.resourceId).toBe(subject.legalEntityId);
      expect(backdatedOutcome.audit.resourceId).not.toBe(backdatedInvocationId);

      const scheduled = declaredOf(
        yield* subject.declare({ effectiveFrom: '2026-08-01T00:00:00.000Z', regime: 'NON_PAYER' }),
      );
      expect(scheduled.revision).toBe(1);
      const unconfirmedInvocationId = randomUUID();
      const unconfirmedOutcome = yield* subject.declare(
        { expectedCurrentRevision: 1, regime: 'VAT_PAYER' },
        unconfirmedInvocationId,
      );
      if ('kind' in unconfirmedOutcome) {
        throw new Error(`Expected a declaration outcome, got ${unconfirmedOutcome.kind}`);
      }
      expect(unconfirmedOutcome.audit.resourceId).toBe(subject.legalEntityId);
      expect(unconfirmedOutcome.audit.resourceId).not.toBe(unconfirmedInvocationId);
    }),
  ),
);

it.live(
  '#943 a DECLARED replay with a corrupted replaced-scheduled-declarations jsonb row fails closed, not guessed',
  () =>
    Effect.scoped(
      Effect.gen(function* corruptedReplacedScheduledAcceptance() {
        const { adminClient, runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        const actionInvocationId = randomUUID();
        const decoded = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
          effectiveFrom: '2026-02-01T00:00:00.000Z',
          expectedCurrentRevision: 0,
          regime: 'VAT_PAYER',
        });
        // Mirrors the service's own `intentFingerprint` so the idempotent-replay match succeeds and the replay
        // path actually decodes this row's `replaced_scheduled_declarations`.
        const fingerprint = taxMeaningFingerprint({
          confirmReplacesScheduled: false,
          effectiveFrom: DateTime.formatIso(decoded.effectiveFrom),
          expectedCurrentRevision: decoded.expectedCurrentRevision,
          reason: null,
          regime: decoded.regime,
        });
        yield* adminClient.unsafe(
          `insert into tax.tax_seller_vat_regime_declarations
             (legal_entity_id, tenant_id, action_invocation_id, actor_principal_id, effective_from,
              idempotency_key, intent_fingerprint, provenance, recorded_at, regime,
              replaced_scheduled_declarations, replaces_scheduled, revision)
           values
             ($1, $2, $3, $4, $5, $6, $7, 'MERCHANT_DECLARED', $5, 'VAT_PAYER',
              '[{"revision": "not-a-number"}]'::jsonb, false, 1)`,
          [
            subject.legalEntityId,
            tenantId,
            actionInvocationId,
            principalId,
            '2026-02-01T00:00:00.000Z',
            actionInvocationId,
            fingerprint,
          ],
        );

        const replay = yield* Effect.exit(subject.declare({ regime: 'VAT_PAYER' }, actionInvocationId));
        // A row outside the vocabulary is an unavailable read, never a guessed `replacedScheduledRevisions` value
        // decoded straight from the drizzle `$type<>` cast.
        expect(Exit.isFailure(replay)).toBe(true);
      }),
    ),
);

it.live('Unit 10 B two sequential declares each get the next revision, and two concurrent ones serialize to it', () =>
  Effect.scoped(
    Effect.gen(function* sequentialAndConcurrentAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const sequential = seller(runtime);
      expect(declaredOf(yield* sequential.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' })).revision).toBe(
        1,
      );
      expect(
        declaredOf(
          yield* sequential.declare({
            effectiveFrom: '2026-03-01T00:00:00.000Z',
            expectedCurrentRevision: 1,
            regime: 'NON_PAYER',
          }),
        ).revision,
      ).toBe(2);

      // Two concurrent first declares on a fresh seller: the seller lock serializes them, so exactly one gets
      // revision 1 and the other observes a stale basis, never both succeeding or both failing (F6).
      const concurrentSubject = seller(runtime);
      const outcomes = yield* Effect.all(
        [
          concurrentSubject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' }),
          concurrentSubject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' }),
        ],
        { concurrency: 2 },
      );
      const stale = outcomes.filter((outcome) => 'kind' in outcome && outcome.kind === 'stale_basis');
      const created = outcomes.filter((outcome) => !('kind' in outcome) && declaredOf(outcome).created);
      expect(stale.length).toBe(1);
      expect(created.length).toBe(1);
    }),
  ),
);

it.live('Unit 10 B the regime selected at an instant follows the timeline rule, scoped per tenant and seller', () =>
  Effect.scoped(
    Effect.gen(function* atInstantAndIsolationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' });
      yield* subject.declare({
        confirmReplacesScheduled: true,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        expectedCurrentRevision: 1,
        regime: 'NON_PAYER',
      });

      const beforeAugust = Option.getOrThrow(yield* subject.atInstant('2026-06-01T00:00:00.000Z'));
      expect(regimeOf(beforeAugust.selection)).toBe('VAT_PAYER');
      const fromAugust = Option.getOrThrow(yield* subject.atInstant('2026-08-01T00:00:00.000Z'));
      expect(regimeOf(fromAugust.selection)).toBe('NON_PAYER');
      const beforeAnyDeclaration = Option.getOrThrow(yield* subject.atInstant('2025-01-01T00:00:00.000Z'));
      expect(isNotDeclared(beforeAnyDeclaration.selection)).toBe(true);

      // Another seller of the same tenant, and the same seller id under another tenant, see nothing of this one.
      const otherSeller = seller(runtime);
      const otherSellerRead = Option.getOrThrow(yield* otherSeller.atInstant('2026-08-01T00:00:00.000Z'));
      expect(isNotDeclared(otherSellerRead.selection)).toBe(true);
      const foreignTenantScope = scopeFor(subject.legalEntityId, randomUUID());
      const foreignTenantRead = Option.getOrThrow(
        yield* runScoped(runtime, foreignTenantScope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, foreignTenantScope).atInstant({
            instant: DateTime.makeUnsafe('2026-08-01T00:00:00.000Z'),
          }),
        ),
      );
      expect(isNotDeclared(foreignTenantRead.selection)).toBe(true);

      const completeHistory = Option.getOrThrow(yield* subject.history());
      expect(completeHistory.revisions.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(completeHistory.completeness.rowCount).toBe(2);
      // History order is independent of insertion order: re-reading gives the identical completeness fingerprint.
      const rereadHistory = Option.getOrThrow(yield* subject.history());
      expect(rereadHistory.completeness.setFingerprint).toBe(completeHistory.completeness.setFingerprint);
    }),
  ),
);

it.live('#950 F24 forced RLS hides declaration rows from another seller scope and from an unscoped runtime', () =>
  Effect.scoped(
    Effect.gen(function* declarationRowLevelSecurity() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      declaredOf(yield* subject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' }));

      // A raw runtime-role read naming the seller's exact rows: RLS itself, not a service filter, decides visibility.
      const sellerRows = (transaction: Pick<ScopedTransactionExecutor, 'select'>) =>
        transaction
          .select({ revision: taxSellerVatRegimeDeclarations.revision })
          .from(taxSellerVatRegimeDeclarations)
          .where(
            and(
              eq(taxSellerVatRegimeDeclarations.tenantId, tenantId),
              eq(taxSellerVatRegimeDeclarations.legalEntityId, subject.legalEntityId),
            ),
          );
      expect(yield* runScoped(runtime, subject.scope, sellerRows)).toEqual([{ revision: 1 }]);
      expect(yield* runScoped(runtime, seller(runtime).scope, sellerRows)).toEqual([]);
      expect(yield* runScoped(runtime, scopeFor(subject.legalEntityId, randomUUID()), sellerRows)).toEqual([]);
      // No Operational Scope installed at all: the runtime role sees no declaration row.
      expect(yield* runtime.transaction(sellerRows)).toEqual([]);
    }),
  ),
);

it.live('Unit 10 B the append-only trigger rejects any update or delete of a declaration row', () =>
  Effect.scoped(
    Effect.gen(function* appendOnlyAcceptance() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' });

      const rewrite = (statement: string) =>
        Effect.exit(adminClient.unsafe(statement, [tenantId, subject.legalEntityId])).pipe(Effect.map(Exit.isFailure));
      expect(
        yield* rewrite(
          `update tax.tax_seller_vat_regime_declarations set regime = 'NON_PAYER' where tenant_id = $1 and legal_entity_id = $2`,
        ),
      ).toBe(true);
      expect(
        yield* rewrite(
          `delete from tax.tax_seller_vat_regime_declarations where tenant_id = $1 and legal_entity_id = $2`,
        ),
      ).toBe(true);
    }),
  ),
);

it.live('Unit 10 B an admin insert that violates the backdating-reason check is rejected at the database', () =>
  Effect.scoped(
    Effect.gen(function* backdatingCheckConstraintAcceptance() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      // Seed one declaration so the direct insert below can target a real seller scope.
      yield* subject.declare({ expectedCurrentRevision: 0, regime: 'VAT_PAYER' });

      const result = yield* Effect.exit(
        adminClient.unsafe(
          `insert into tax.tax_seller_vat_regime_declarations
             (legal_entity_id, tenant_id, action_invocation_id, actor_principal_id, effective_from,
              idempotency_key, intent_fingerprint, provenance, recorded_at, regime, replaces_scheduled, revision)
           values
             ($1, $2, $3, $4, '2020-01-01T00:00:00.000Z',
              $3, repeat('a', 64), 'MERCHANT_DECLARED', now(), 'NON_PAYER', false, 2)`,
          [subject.legalEntityId, tenantId, randomUUID(), principalId],
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  ),
);
