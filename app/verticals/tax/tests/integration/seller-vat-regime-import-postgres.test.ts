import { NodeCrypto } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Match, Option, Schema } from 'effect';
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
  ImportSellerVatRegimeDeclarationsResultSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import { SellerVatRegimeHistoryResponseContractSchema } from '../../shared/domain/seller-vat-regime-contracts.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import { taxRelations, taxSellerVatRegimeDeclarations } from '../../src/database/schema.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const MIGRATION_STARTED_AT = '2026-01-15T00:00:00.000Z';
const T = '2026-06-01T00:00:00.000Z';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

interface FixtureIdentity {
  readonly principalId: string;
  readonly tenantId: string;
}

const scopeFor = Effect.fnUntraced(function* fixtureScopeFor(identity: FixtureIdentity, legalEntityId: string) {
  const scope: OperationalScope = {
    authContextRef: `better-auth-session:${yield* nextUuid}`,
    authMethod: 'session',
    correlationId: yield* nextUuid,
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

// The import runs after the migration start, so a current-only effect is earlier than `recorded_at`: an imported
// source declaration needs no backdating reason.
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope, actionInvocationId: string, at: Date = operationTime) => ({
  actionInvocationId,
  actorPrincipalId: scope.principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>, tenantId: string) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupSellerVatRegimeImportRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireSellerVatRegimeImportTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  const identity: FixtureIdentity = { principalId: yield* nextUuid, tenantId: yield* nextUuid };
  yield* cleanup(admin, identity.tenantId);
  yield* Effect.addFinalizer(() => cleanup(admin, identity.tenantId).pipe(Effect.orDie));
  return { adminClient, identity, runtime };
});

type ImportPayloadInput = Partial<typeof ImportSellerVatRegimeDeclarationsPayloadSchema.Encoded>;

/** One seller, exercised through the same owner service the import and declare Actions use. */
const seller = Effect.fnUntraced(function* sellerFixture(runtime: CoreTestDatabase, identity: FixtureIdentity) {
  const legalEntityId = yield* nextUuid;
  const scope = yield* scopeFor(identity, legalEntityId);
  const importDeclarations = (
    overrides: ImportPayloadInput = {},
    actionInvocationId?: string,
    at: Date = operationTime,
  ) =>
    Effect.all({
      decoded: Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)({
        declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: `legacy:${legalEntityId}` }],
        migrationRunRef: 'migration-run-1',
        migrationStartedAt: MIGRATION_STARTED_AT,
        ...overrides,
      }),
      invocationId: actionInvocationId === undefined ? nextUuid : Effect.succeed(actionInvocationId),
    }).pipe(
      Effect.flatMap(({ decoded, invocationId }) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).importDeclarations({
            ...decoded,
            ...invocation(scope, invocationId, at),
          }),
        ),
      ),
    );
  const declare = (overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {}) =>
    Effect.all({
      decoded: Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        expectedCurrentRevision: 0,
        regime: 'VAT_PAYER',
        ...overrides,
      }),
      invocationId: nextUuid,
    }).pipe(
      Effect.flatMap(({ decoded, invocationId }) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
            ...decoded,
            ...invocation(scope, invocationId),
          }),
        ),
      ),
    );
  const atInstant = (instant: string) =>
    runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).atInstant({ instant: DateTime.makeUnsafe(instant) }),
    ).pipe(Effect.map((response) => Option.getOrThrow(response).selection));
  const history = runScoped(runtime, scope, (transaction) =>
    sellerVatRegimeDeclarationsForScope(transaction, scope).history.pipe(Effect.map(Option.getOrThrow)),
  );
  return { atInstant, declare, history, importDeclarations, legalEntityId, scope };
});

type ImportOutcome = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof seller>>['importDeclarations']>>;
/** Every result crosses the public Action contract: encoded, then decoded again. */
const roundTrip = Schema.decodeSync(ImportSellerVatRegimeDeclarationsResultSchema);
const encodeImportResult = Schema.encodeSync(ImportSellerVatRegimeDeclarationsResultSchema);

const importResultOf = (outcome: ImportOutcome) => {
  if ('kind' in outcome) {
    throw new Error(`Expected an import result, got ${outcome.kind}`);
  }
  return roundTrip(encodeImportResult(outcome.result));
};

const importedOf = (outcome: ImportOutcome) =>
  Match.value(importResultOf(outcome)).pipe(
    Match.tag('IMPORTED', (imported) => imported),
    Match.tag('IMPORT_REJECTED', ({ reason }) => {
      throw new Error(`Expected IMPORTED, got IMPORT_REJECTED(${reason})`);
    }),
    Match.exhaustive,
  );

const rejectionOf = (outcome: ImportOutcome) =>
  Match.value(importResultOf(outcome)).pipe(
    Match.tag('IMPORT_REJECTED', ({ reason }) => reason),
    Match.tag('IMPORTED', () => {
      throw new Error('Expected IMPORT_REJECTED, got IMPORTED');
    }),
    Match.exhaustive,
  );

/** The regime of one selection, or `NOT_DECLARED`. */
const regimeOf = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime),
    Match.tag('NOT_DECLARED', () => 'NOT_DECLARED' as const),
    Match.exhaustive,
  );

const encodeHistory = Schema.encodeSync(SellerVatRegimeHistoryResponseContractSchema);
const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('seller VAT regime import', (suite) => {
  suite.effect(
    '907-Q08 #960 payer and non-payer sellers import their source declarations without a new confirmation, isolated per Selling Legal Entity',
    () =>
      Effect.scoped(
        Effect.gen(function* payerAndNonPayerImportAcceptance() {
          const { identity, runtime } = yield* acquireDatabases;
          const payer = yield* seller(runtime, identity);
          const nonPayer = yield* seller(runtime, identity);

          const payerImport = importedOf(
            yield* payer.importDeclarations({
              declarations: [
                { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
              ],
            }),
          );
          expect(payerImport.created).toBe(true);
          expect(
            payerImport.revisions.map(({ effectiveFrom, effectiveFromOrigin, revision, sourceRecordRef }) => ({
              effectiveFrom: iso(effectiveFrom),
              effectiveFromOrigin,
              revision,
              sourceRecordRef,
            })),
          ).toEqual([
            {
              effectiveFrom: '2025-01-01T00:00:00.000Z',
              effectiveFromOrigin: 'SOURCE',
              revision: 1,
              sourceRecordRef: 'legacy:payer',
            },
          ]);
          expect(
            importedOf(
              yield* nonPayer.importDeclarations({
                declarations: [{ regime: 'NON_PAYER', sourceRecordRef: 'legacy:non-payer' }],
              }),
            ).created,
          ).toBe(true);

          // Each seller sees only its own declared regime: no fallback, no confirmation step, no verification.
          expect(regimeOf(yield* payer.atInstant(T))).toBe('VAT_PAYER');
          expect(regimeOf(yield* nonPayer.atInstant(T))).toBe('NON_PAYER');

          const payerHistory = yield* payer.history;
          expect(payerHistory.completeness.rowCount).toBe(1);
          expect(encodeHistory(payerHistory).revisions).toEqual([
            expect.objectContaining({
              declaredBy: identity.principalId,
              effectiveFrom: '2025-01-01T00:00:00.000Z',
              effectiveFromOrigin: 'SOURCE',
              migrationRunRef: 'migration-run-1',
              provenance: 'MIGRATED',
              reason: null,
              recordedAt: '2026-02-01T00:00:00.000Z',
              regime: 'VAT_PAYER',
              revision: 1,
              sourceRecordRef: 'legacy:payer',
            }),
          ]);
          // Never presented as verified or confirmed: provenance says how the row was obtained, nothing more.
          expect(
            Object.keys(encodeHistory(payerHistory).revisions[0] ?? {}).filter((key) => /verif|confirm/iu.test(key)),
          ).toEqual([]);

          // Forced RLS: the payer's scoped transaction sees no row of the other Selling Legal Entity.
          const visibleSellers = yield* runScoped(runtime, payer.scope, (transaction) =>
            transaction
              .select({ legalEntityId: taxSellerVatRegimeDeclarations.legalEntityId })
              .from(taxSellerVatRegimeDeclarations)
              .where(eq(taxSellerVatRegimeDeclarations.tenantId, identity.tenantId)),
          );
          expect(visibleSellers.map(({ legalEntityId }) => legalEntityId)).toEqual([payer.legalEntityId]);
          // An invocation naming another seller than the trusted scope is unavailable, never an import into it.
          const crossInvocationId = yield* nextUuid;
          const crossSeller = yield* Effect.exit(
            Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)({
              declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: 'legacy:cross' }],
              migrationRunRef: 'migration-run-1',
              migrationStartedAt: MIGRATION_STARTED_AT,
            }).pipe(
              Effect.flatMap((decoded) =>
                runScoped(runtime, payer.scope, (transaction) =>
                  sellerVatRegimeDeclarationsForScope(transaction, payer.scope).importDeclarations({
                    ...decoded,
                    ...invocation(nonPayer.scope, crossInvocationId),
                  }),
                ),
              ),
            ),
          );
          expect(Exit.isFailure(crossSeller)).toBe(true);
          expect((yield* nonPayer.history).completeness.rowCount).toBe(1);
        }),
      ),
  );

  suite.effect(
    '907-Q08 #925 a current-only source takes effect at the migration instant and fabricates no earlier history',
    () =>
      Effect.scoped(
        Effect.gen(function* currentOnlyImportAcceptance() {
          const { identity, runtime } = yield* acquireDatabases;
          const subject = yield* seller(runtime, identity);

          const imported = importedOf(yield* subject.importDeclarations());
          expect(
            imported.revisions.map(({ effectiveFrom, effectiveFromOrigin }) => [
              iso(effectiveFrom),
              effectiveFromOrigin,
            ]),
          ).toEqual([[MIGRATION_STARTED_AT, 'MIGRATION_START']]);

          expect(regimeOf(yield* subject.atInstant('2026-01-14T23:59:59.999Z'))).toBe('NOT_DECLARED');
          const atStart = Match.value(yield* subject.atInstant(MIGRATION_STARTED_AT)).pipe(
            Match.tag('DECLARED', (declared) => declared),
            Match.tag('NOT_DECLARED', () => {
              throw new Error('Expected the migration start to be covered');
            }),
            Match.exhaustive,
          );
          expect(atStart).toMatchObject({
            declarationRevisionRef: { revision: 1 },
            effectiveFromOrigin: 'MIGRATION_START',
            migrationRunRef: 'migration-run-1',
            provenance: 'MIGRATED',
            regime: 'VAT_PAYER',
            sourceRecordRef: `legacy:${subject.legalEntityId}`,
          });
        }),
      ),
  );

  suite.effect(
    '907-Q08 #925 an exact replay with a new idempotency key stores nothing and keeps the same migration start',
    () =>
      Effect.scoped(
        Effect.gen(function* replayImportAcceptance() {
          const { identity, runtime } = yield* acquireDatabases;
          const subject = yield* seller(runtime, identity);

          const first = importedOf(yield* subject.importDeclarations());
          const before = yield* subject.history;
          // A retry of the same run, later, under another Core invocation: the start never shifts to the retry time.
          const replay = importedOf(
            yield* subject.importDeclarations({}, yield* nextUuid, DateTime.toDateUtc(DateTime.makeUnsafe(T))),
          );
          expect(replay.created).toBe(false);
          expect(replay.revisions).toEqual(first.revisions);
          const after = yield* subject.history;
          expect(after.completeness).toEqual(before.completeness);
          expect(after.revisions.map(({ effectiveFrom, recordedAt }) => [iso(effectiveFrom), iso(recordedAt)])).toEqual(
            [[MIGRATION_STARTED_AT, '2026-02-01T00:00:00.000Z']],
          );
        }),
      ),
  );

  suite.effect('907-Q08 #925 dated source history and a scheduled future change are preserved in order', () =>
    Effect.scoped(
      Effect.gen(function* datedHistoryImportAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);

        const imported = importedOf(
          yield* subject.importDeclarations({
            declarations: [
              { effectiveFrom: '2027-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:scheduled' },
              {
                effectiveFrom: '2024-01-01T00:00:00.000Z',
                reason: 'Registered as a payer later',
                regime: 'NON_PAYER',
                sourceRecordRef: 'legacy:first',
              },
              { effectiveFrom: '2025-06-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
            ],
          }),
        );
        expect(imported.revisions.map(({ revision, sourceRecordRef }) => [revision, sourceRecordRef])).toEqual([
          [1, 'legacy:first'],
          [2, 'legacy:payer'],
          [3, 'legacy:scheduled'],
        ]);
        expect(imported.revisions.every(({ effectiveFromOrigin }) => effectiveFromOrigin === 'SOURCE')).toBe(true);

        expect(regimeOf(yield* subject.atInstant('2023-12-31T23:59:59.999Z'))).toBe('NOT_DECLARED');
        expect(regimeOf(yield* subject.atInstant('2024-06-01T00:00:00.000Z'))).toBe('NON_PAYER');
        expect(regimeOf(yield* subject.atInstant(T))).toBe('VAT_PAYER');
        expect(regimeOf(yield* subject.atInstant('2027-06-01T00:00:00.000Z'))).toBe('NON_PAYER');
        expect(Option.getOrNull((yield* subject.history).revisions[0]?.reason ?? Option.none())).toBe(
          'Registered as a payer later',
        );
      }),
    ),
  );

  suite.effect(
    '907-Q08 #922 a seller already declared directly or by another run is rejected and nothing is stored',
    () =>
      Effect.scoped(
        Effect.gen(function* alreadyDeclaredImportAcceptance() {
          const { identity, runtime } = yield* acquireDatabases;
          const direct = yield* seller(runtime, identity);
          yield* direct.declare();
          expect(rejectionOf(yield* direct.importDeclarations())).toBe('SELLER_ALREADY_DECLARED');
          expect((yield* direct.history).revisions.map(({ provenance }) => provenance)).toEqual(['MERCHANT_DECLARED']);

          const otherRun = yield* seller(runtime, identity);
          importedOf(yield* otherRun.importDeclarations({ migrationRunRef: 'migration-run-0' }));
          expect(rejectionOf(yield* otherRun.importDeclarations())).toBe('SELLER_ALREADY_DECLARED');
          expect((yield* otherRun.history).completeness.rowCount).toBe(1);
        }),
      ),
  );

  suite.effect('907-Q08 #960 the same run with different content is a run conflict and stores nothing', () =>
    Effect.scoped(
      Effect.gen(function* runConflictImportAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        importedOf(yield* subject.importDeclarations());
        const before = yield* subject.history;

        expect(
          rejectionOf(
            yield* subject.importDeclarations({
              declarations: [{ regime: 'NON_PAYER', sourceRecordRef: `legacy:${subject.legalEntityId}` }],
            }),
          ),
        ).toBe('MIGRATION_RUN_CONFLICT');
        // A shifted migration instant is other content too: the start of a run never moves.
        expect(rejectionOf(yield* subject.importDeclarations({ migrationStartedAt: '2026-01-20T00:00:00.000Z' }))).toBe(
          'MIGRATION_RUN_CONFLICT',
        );
        expect((yield* subject.history).completeness).toEqual(before.completeness);
      }),
    ),
  );

  suite.effect('907-Q08 #960 ambiguous source history is rejected and stores nothing', () =>
    Effect.scoped(
      Effect.gen(function* ambiguousImportAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        expect(
          rejectionOf(
            yield* subject.importDeclarations({
              declarations: [
                { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:a' },
                { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:b' },
              ],
            }),
          ),
        ).toBe('AMBIGUOUS_SOURCE_HISTORY');
        expect(
          rejectionOf(
            yield* subject.importDeclarations({
              declarations: [
                { regime: 'VAT_PAYER', sourceRecordRef: 'legacy:current' },
                { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:dated' },
              ],
            }),
          ),
        ).toBe('AMBIGUOUS_SOURCE_HISTORY');
        expect((yield* subject.history).completeness.rowCount).toBe(0);
      }),
    ),
  );

  suite.effect('907-Q08 #925 a later change after the import goes through the declare Action with CAS', () =>
    Effect.scoped(
      Effect.gen(function* laterDeclareAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        importedOf(
          yield* subject.importDeclarations({
            declarations: [
              { effectiveFrom: '2024-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:first' },
              { effectiveFrom: '2025-06-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
            ],
          }),
        );

        expect(yield* subject.declare({ expectedCurrentRevision: 0, regime: 'NON_PAYER' })).toEqual({
          kind: 'stale_basis',
        });
        const declared = yield* subject.declare({ expectedCurrentRevision: 2, regime: 'NON_PAYER' });
        if ('kind' in declared) {
          throw new Error(`Expected a declaration result, got ${declared.kind}`);
        }
        expect(
          Match.value(declared.result).pipe(
            Match.tag('DECLARED', ({ revision }) => revision),
            Match.tag('DECLARATION_REJECTED', ({ reason }) => reason),
            Match.exhaustive,
          ),
        ).toBe(3);
        expect(regimeOf(yield* subject.atInstant('2026-10-01T00:00:00.000Z'))).toBe('NON_PAYER');
        expect(
          (yield* subject.history).revisions.map(({ effectiveFromOrigin, provenance }) => [
            provenance,
            effectiveFromOrigin,
          ]),
        ).toEqual([
          ['MIGRATED', 'SOURCE'],
          ['MIGRATED', 'SOURCE'],
          ['MERCHANT_DECLARED', 'DECLARED'],
        ]);
        // Re-running the import after a direct change never imports over it.
        expect(
          rejectionOf(
            yield* subject.importDeclarations({
              declarations: [
                { effectiveFrom: '2024-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:first' },
                { effectiveFrom: '2025-06-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
              ],
            }),
          ),
        ).toBe('SELLER_ALREADY_DECLARED');
      }),
    ),
  );

  suite.effect(
    '907-Q08 #960 the database ties MIGRATED to its run, source record and origin, and DECLARED to merchant rows',
    () =>
      Effect.scoped(
        Effect.gen(function* migrationCheckConstraintAcceptance() {
          const { adminClient, identity, runtime } = yield* acquireDatabases;
          const subject = yield* seller(runtime, identity);
          const insert = (provenance: string, origin: string, runRef: string | null, sourceRef: string | null) =>
            nextUuid.pipe(
              Effect.flatMap((invocationId) =>
                Effect.exit(
                  adminClient.unsafe(
                    `insert into tax.tax_seller_vat_regime_declarations
                 (legal_entity_id, tenant_id, action_invocation_id, actor_principal_id, effective_from,
                  effective_from_origin, idempotency_key, intent_fingerprint, migration_run_ref, provenance, reason,
                  recorded_at, regime, replaces_scheduled, revision, source_record_ref)
               values
                 ($1, $2, $3, $4, '2027-01-01T00:00:00.000Z', $5, $3, repeat('a', 64), $6, $7, null, now(), 'VAT_PAYER',
                  false, 1, $8)`,
                    [
                      subject.legalEntityId,
                      identity.tenantId,
                      invocationId,
                      identity.principalId,
                      origin,
                      runRef,
                      provenance,
                      sourceRef,
                    ],
                  ),
                ),
              ),
              Effect.map(Exit.isFailure),
            );
          expect(yield* insert('MIGRATED', 'SOURCE', null, 'legacy:a')).toBe(true);
          expect(yield* insert('MIGRATED', 'DECLARED', 'run', 'legacy:a')).toBe(true);
          expect(yield* insert('MERCHANT_DECLARED', 'DECLARED', 'run', null)).toBe(true);
          expect(yield* insert('MERCHANT_DECLARED', 'MIGRATION_START', null, null)).toBe(true);
          expect(yield* insert('MIGRATED', 'VERIFIED', 'run', 'legacy:a')).toBe(true);
          expect((yield* subject.history).completeness.rowCount).toBe(0);
        }),
      ),
  );
});
