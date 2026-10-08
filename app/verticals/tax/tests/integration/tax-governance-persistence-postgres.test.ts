import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgSession,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
  CreateTaxRuleRevisionPayloadSchema,
  EndTaxFactAuthorityContractPayloadSchema,
  EndTaxRuleRevisionPayloadSchema,
  EstablishTaxFactAuthorityContractPayloadSchema,
  ReviseTaxFactAuthorityContractPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import {
  ApplicableTaxRuleSetRequestContractSchema,
  TaxFactAuthorityCurrentRequestContractSchema,
} from '../../shared/domain/tax-governed-read-contracts.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
} from '../../src/database/schema.ts';
import { taxAuthorityGovernancePersistenceForScope } from '../../src/services/tax-authority-governance.service.ts';
import { taxGovernedReadsForScope } from '../../src/services/tax-governed-read.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const sellerA = randomUUID();
const sellerB = randomUUID();
const principalId = randomUUID();

const scopeFor = (tenant: string, legalEntityId: string): OperationalScope => ({
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId: tenant,
});
const scopeA = scopeFor(tenantId, sellerA);
const scopeB = scopeFor(tenantId, sellerB);
const otherTenantScope = scopeFor(otherTenantId, sellerA);

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

/** Fixed trusted operation time, so lifecycle assertions never depend on the wall clock. */
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));

const invocation = (scope: OperationalScope, at: Date = operationTime) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});

const ruleRef = (resourceId: string) =>
  ({
    moduleId: 'commerce.tax',
    resourceId,
    resourceType: 'commerce.tax.tax-rule',
    tenantId,
  }) as const;
const revisionRef = (resourceId: string) =>
  ({
    moduleId: 'commerce.tax',
    resourceId,
    resourceType: 'commerce.tax.tax-rule-revision',
    tenantId,
  }) as const;
const contractRef = (resourceId: string) =>
  ({
    moduleId: 'commerce.tax',
    resourceId,
    resourceType: 'commerce.tax.tax-fact-authority-contract',
    tenantId,
  }) as const;

const baseContent = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'cz-standard-goods',
  treatmentCategory: 'TAXABLE',
} as const;
const content = (
  overrides: Readonly<{
    effectiveFrom?: string;
    effectiveTo?: string;
    ratePercent?: string;
    taxClassificationCode?: string;
  }> = {},
) => ({ ...baseContent, ...overrides });

const RuleIdSchema = Schema.String.pipe(Schema.brand('TaxTestRuleId'));
const RevisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestRevisionId'));
const ContractIdSchema = Schema.String.pipe(Schema.brand('TaxTestContractId'));

const CreatedRuleSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRevisionId: RevisionIdSchema,
  meaningFingerprint: Schema.String,
  revisionNumber: Schema.Int,
  taxRuleId: RuleIdSchema,
});
const CreatedRevisionSchema = Schema.Struct({
  created: Schema.Boolean,
  meaningFingerprint: Schema.String,
  revisionId: RevisionIdSchema,
  revisionNumber: Schema.Int,
});
const EndedRevisionSchema = Schema.Struct({ ended: Schema.Boolean, revisionId: RevisionIdSchema });
const CorrectedSchema = Schema.Struct({
  correctingRevisionId: RevisionIdSchema,
  created: Schema.Boolean,
  wrongRevisionId: RevisionIdSchema,
});
const ContractOutcomeSchema = Schema.Struct({
  contractId: ContractIdSchema,
  created: Schema.Boolean,
  revisionNumber: Schema.Int,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxGovernanceRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      for (const tenant of [tenantId, otherTenantId]) {
        yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenant));
        yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenant));
        yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenant));
        yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenant));
        yield* transaction
          .delete(taxFactAuthorityContractRevisions)
          .where(eq(taxFactAuthorityContractRevisions.tenantId, tenant));
        yield* transaction.delete(taxFactAuthorityContracts).where(eq(taxFactAuthorityContracts.tenantId, tenant));
      }
    }),
  );

type RulePersistence = ReturnType<typeof taxRuleGovernancePersistenceForScope>;
type AuthorityPersistence = ReturnType<typeof taxAuthorityGovernancePersistenceForScope>;
type GovernedReads = ReturnType<typeof taxGovernedReadsForScope>;

const withRules =
  (runtime: CoreTestDatabase, scope: OperationalScope) =>
  <Value, Failure>(operation: (persistence: RulePersistence) => Effect.Effect<Value, Failure>) =>
    runScoped(runtime, scope, (transaction) => operation(taxRuleGovernancePersistenceForScope(transaction, scope)));
const withAuthority =
  (runtime: CoreTestDatabase, scope: OperationalScope) =>
  <Value, Failure>(operation: (persistence: AuthorityPersistence) => Effect.Effect<Value, Failure>) =>
    runScoped(runtime, scope, (transaction) =>
      operation(taxAuthorityGovernancePersistenceForScope(transaction, scope)),
    );
const withReads =
  (runtime: CoreTestDatabase, scope: OperationalScope) =>
  <Value, Failure>(operation: (reads: GovernedReads) => Effect.Effect<Value, Failure>) =>
    runScoped(runtime, scope, (transaction) => operation(taxGovernedReadsForScope(transaction, scope)));

/** Visible evidence history of one Tax Rule in the given trusted scope. */
const ruleHistory = (runtime: CoreTestDatabase, scope: OperationalScope) => (taxRuleId: string) =>
  withReads(
    runtime,
    scope,
  )((read) => read.taxRuleHistory({ taxRuleRef: ruleRef(taxRuleId) })).pipe(Effect.map(Option.getOrThrow));

const applicableRequest = (taxRelevantTime: string) =>
  Schema.decodeEffect(ApplicableTaxRuleSetRequestContractSchema)({
    jurisdiction: 'CZ_DOMESTIC',
    taxClassificationCode: 'cz-standard-goods',
    taxRelevantTime,
  });
/** Complete applicable Tax Rule set for the launch predicate at a Tax-Relevant Time in the given trusted scope. */
const applicableSet = (runtime: CoreTestDatabase, scope: OperationalScope) => (taxRelevantTime: string) =>
  applicableRequest(taxRelevantTime).pipe(
    Effect.flatMap((request) => withReads(runtime, scope)((read) => read.applicableTaxRuleSet(request))),
  );

const authorityRequest = (instant: string) =>
  Schema.decodeEffect(TaxFactAuthorityCurrentRequestContractSchema)({
    factFamily: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
    instant,
  });
const establishPayload = (stableCode: string, authorityFrom: string, systemOfRecordRef: string) =>
  Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
    authority: { authorityFrom, evidenceSourceRefs: ['tax.vies-check'], systemOfRecordRef },
    factFamily: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
    provenanceRef: `acceptance:${stableCode}`,
    reason: 'Govern VAT registration authority',
    stableCode,
  });
const createRulePayload = (stableCode: string, initialRevision: ReturnType<typeof content>) =>
  Schema.decodeEffect(CreateTaxRulePayloadSchema)({
    initialRevision,
    meaningKind: 'VAT_RATE',
    provenanceRef: `acceptance:${stableCode}`,
    reason: 'Czech VAT rate',
    stableCode,
  });

const acquireDatabases = Effect.gen(function* acquireTaxTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { admin, adminClient, runtime };
});

/** Waits until some backend is blocked behind the given backend; the interleaving is then deterministic. */
const awaitBlockedBehind = (observer: Effect.Success<typeof testDatabaseClients>['admin'], blockingPid: number) =>
  Effect.gen(function* awaitBlockedBackend() {
    for (let observation = 0; observation < 1000; observation += 1) {
      const [row] = yield* observer.unsafe<{ blocked: boolean }>(
        'select exists (select 1 from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))) as blocked',
        [blockingPid],
      );
      if (row?.blocked === true) {
        return true;
      }
      yield* Effect.sleep('10 millis');
    }
    return false;
  });

/** Waits until a runtime writer is blocked on the Tax Rule row lock held by a concurrent governed change. */
const awaitRuleLockWaiter = (observer: Effect.Success<typeof testDatabaseClients>['admin']) =>
  Effect.gen(function* awaitRuleLockWaiterEffect() {
    for (let observation = 0; observation < 1000; observation += 1) {
      const [row] = yield* observer.unsafe<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
           where wait_event_type = 'Lock' and query like '%"tax_rules"%for update%'
         ) as blocked`,
      );
      if (row?.blocked === true) {
        return true;
      }
      yield* Effect.sleep('10 millis');
    }
    return false;
  });

it.live(
  '#929 #930 F8 #955 Tax Rule governance replays, rejects reused keys and stale bases, and keeps corrections addressable',
  () =>
    Effect.scoped(
      Effect.gen(function* taxRuleGovernanceAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const rules = withRules(runtime, scopeA);
        const history = ruleHistory(runtime, scopeA);

        const createInput = {
          ...(yield* createRulePayload('cz.standard-goods', content({ effectiveTo: '2027-01-01T00:00:00.000Z' }))),
          ...invocation(scopeA),
        };
        const created = yield* rules((persistence) => persistence.createTaxRule(createInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
        );
        expect(created).toMatchObject({ created: true, revisionNumber: 1 });

        // #955 same invocation and same meaning replays without a second write.
        const replayed = yield* rules((persistence) => persistence.createTaxRule(createInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
        );
        expect(replayed).toEqual({ ...created, created: false });

        // #955 same idempotency key with different meaning is a typed conflict, never a silent overwrite.
        const reused = yield* rules((persistence) =>
          persistence.createTaxRule({
            ...createInput,
            initialRevision: { ...createInput.initialRevision, ratePercent: '12' },
          }),
        );
        expect(reused).toEqual({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' });

        const duplicateCode = yield* rules((persistence) =>
          persistence.createTaxRule({ ...createInput, ...invocation(scopeA) }),
        );
        expect(duplicateCode).toEqual({ conflict: 'STABLE_CODE', kind: 'conflict' });

        const ruleBasis = (yield* history(created.taxRuleId)).basisFingerprint;
        const revisionInput = {
          ...(yield* Schema.decodeEffect(CreateTaxRuleRevisionPayloadSchema)({
            content: content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '23' }),
            expectedBasisFingerprint: ruleBasis,
            provenanceRef: 'acceptance:planned-rate-change',
            reason: 'Planned future rate change',
            taxRuleRef: ruleRef(created.taxRuleId),
          })),
          ...invocation(scopeA),
        };

        // #949 F20 #955 a basis that is not the current governing revision set is stale.
        const stale = yield* rules((persistence) =>
          persistence.createTaxRuleRevision({ ...revisionInput, expectedBasisFingerprint: '0'.repeat(64) }),
        );
        expect(stale).toEqual({ kind: 'stale_basis' });

        const future = yield* rules((persistence) => persistence.createTaxRuleRevision(revisionInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)),
        );
        expect(future).toMatchObject({ created: true, revisionNumber: 2 });
        const futureReplay = yield* rules((persistence) => persistence.createTaxRuleRevision(revisionInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)),
        );
        expect(futureReplay).toEqual({ ...future, created: false });

        // The superseded basis is stale for any new invocation.
        const staleAfterChange = yield* rules((persistence) =>
          persistence.createTaxRuleRevision({ ...revisionInput, ...invocation(scopeA) }),
        );
        expect(staleAfterChange).toEqual({ kind: 'stale_basis' });

        // #929 F1-F3 a revision cannot silently reinterpret the stable rule meaning.
        const currentBasis = (yield* history(created.taxRuleId)).basisFingerprint;
        const meaningChanged = yield* rules((persistence) =>
          persistence.createTaxRuleRevision({
            ...revisionInput,
            ...invocation(scopeA),
            content: { ...revisionInput.content, taxClassificationCode: 'cz-reduced-books' },
            expectedBasisFingerprint: currentBasis,
          }),
        );
        expect(meaningChanged).toEqual({ conflict: 'MEANING_CHANGED', kind: 'conflict' });

        // Ending is a separate fact guarded by the whole-rule basis (#949 F19).
        const firstRevisionBasis = (yield* history(created.taxRuleId)).basisFingerprint;
        const endInput = {
          ...(yield* Schema.decodeEffect(EndTaxRuleRevisionPayloadSchema)({
            endedEffectiveTo: '2026-07-01T00:00:00.000Z',
            expectedBasisFingerprint: firstRevisionBasis,
            provenanceRef: 'acceptance:end',
            reason: 'Rate withdrawn early',
            taxRuleRevisionRef: revisionRef(created.initialRevisionId),
          })),
          ...invocation(scopeA),
        };
        const ended = yield* rules((persistence) => persistence.endTaxRuleRevision(endInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
        );
        expect(ended.ended).toBe(true);
        const endReplay = yield* rules((persistence) => persistence.endTaxRuleRevision(endInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
        );
        expect(endReplay.ended).toBe(false);
        const endedBasis = (yield* history(created.taxRuleId)).basisFingerprint;
        const endAgain = yield* rules((persistence) =>
          persistence.endTaxRuleRevision({ ...endInput, ...invocation(scopeA), expectedBasisFingerprint: endedBasis }),
        );
        expect(endAgain).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });

        // #930 F8 a confirmed correction appends a correcting revision plus provenance atomically.
        const wrongBasis = (yield* history(created.taxRuleId)).basisFingerprint;
        const correctInput = {
          ...(yield* Schema.decodeEffect(CorrectTaxRuleRevisionPayloadSchema)({
            confirmedAt: '2026-03-01T00:00:00.000Z',
            correctingContent: content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '21' }),
            expectedBasisFingerprint: wrongBasis,
            provenanceRef: 'acceptance:correction',
            reason: 'Planned rate was announced wrongly',
            wrongRevisionRef: revisionRef(future.revisionId),
          })),
          ...invocation(scopeA),
        };
        const corrected = yield* rules((persistence) => persistence.correctTaxRuleRevision(correctInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CorrectedSchema)),
        );
        expect(corrected).toMatchObject({ created: true, wrongRevisionId: future.revisionId });
        const correctedReplay = yield* rules((persistence) => persistence.correctTaxRuleRevision(correctInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CorrectedSchema)),
        );
        expect(correctedReplay).toEqual({ ...corrected, created: false });

        const evidence = yield* history(created.taxRuleId);
        expect(evidence.revisions.map(({ revisionNumber }) => revisionNumber)).toEqual([1, 2, 3]);
        expect(evidence.revisions[1]?.ratePercent).toBe('23');
        expect(evidence.revisions[2]?.supersedesRevisionRef).toEqual(Option.some(revisionRef(future.revisionId)));
        expect(evidence.revisions[0]?.endFact.pipe(Option.isSome)).toBe(true);
        // Only the rule-level expected-current basis is a governed token; no Action accepts a per-revision one.
        for (const revision of evidence.revisions) {
          expect(revision).not.toHaveProperty('basisFingerprint');
        }
        expect(evidence.corrections.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
          future.revisionId,
        ]);

        const applicableAt = applicableSet(runtime, scopeA);
        // #929 F4-F10 #930 F8 the end fact and confirmed correction decide applicability over the complete set.
        const corrected2027 = yield* applicableAt('2027-06-01T00:00:00.000Z');
        expect(corrected2027.outcome).toBe('SELECTED');
        expect(corrected2027.applicable.map(({ taxRuleRevisionRef }) => taxRuleRevisionRef.resourceId)).toEqual([
          corrected.correctingRevisionId,
        ]);
        expect(corrected2027.excludedByCorrection.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
          future.revisionId,
        ]);
        expect(corrected2027.completeness.rowCount).toBe(3);
        expect((yield* applicableAt('2026-03-01T00:00:00.000Z')).applicable[0]?.ratePercent).toBe('21');
        expect((yield* applicableAt('2026-07-01T00:00:00.000Z')).outcome).toBe('TAX_RULE_MISSING');
        const repeated = yield* applicableAt('2027-06-01T00:00:00.000Z');
        expect(repeated.completeness.setFingerprint).toBe(corrected2027.completeness.setFingerprint);
      }),
    ),
);

it.live('#950 F24-F28 Tax governance state is isolated per Tenant and Selling Legal Entity by forced RLS', () =>
  Effect.scoped(
    Effect.gen(function* taxGovernanceIsolation() {
      const { runtime } = yield* acquireDatabases;
      const createInput = { ...(yield* createRulePayload('cz.seller-a', content())), ...invocation(scopeA) };
      const created = yield* withRules(
        runtime,
        scopeA,
      )((persistence) => persistence.createTaxRule(createInput)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
      );

      // Seller B in the same Tenant sees neither the rule nor its revisions.
      const sellerBReads = withReads(runtime, scopeB);
      const request = yield* applicableRequest('2026-06-01T00:00:00.000Z');
      const sellerBSet = yield* sellerBReads((read) => read.applicableTaxRuleSet(request));
      expect(sellerBSet).toMatchObject({ completeness: { rowCount: 0 }, outcome: 'TAX_RULE_MISSING' });
      const sellerBHistory = yield* sellerBReads((read) =>
        read.taxRuleHistory({ taxRuleRef: ruleRef(created.taxRuleId) }),
      );
      expect(Option.isNone(sellerBHistory)).toBe(true);
      const revisionPayload = yield* Schema.decodeEffect(CreateTaxRuleRevisionPayloadSchema)({
        content: content(),
        expectedBasisFingerprint: '0'.repeat(64),
        provenanceRef: 'acceptance:seller-b',
        reason: 'Seller B cannot govern Seller A rules',
        taxRuleRef: ruleRef(created.taxRuleId),
      });
      const sellerBRevision = yield* withRules(
        runtime,
        scopeB,
      )((persistence) => persistence.createTaxRuleRevision({ ...revisionPayload, ...invocation(scopeB) }));
      expect(sellerBRevision).toEqual({ kind: 'not_found' });

      // RLS itself, not the service filter, hides the rows from another Tenant or seller.
      const visibleRules = (scope: OperationalScope) =>
        runScoped(runtime, scope, (transaction) =>
          transaction.select({ taxRuleId: taxRules.taxRuleId }).from(taxRules),
        );
      expect(yield* visibleRules(otherTenantScope)).toEqual([]);
      expect(yield* visibleRules(scopeB)).toEqual([]);
      expect(yield* visibleRules(scopeA)).toEqual([{ taxRuleId: created.taxRuleId }]);

      // A payload cannot write into another seller's scope: the trusted scope decides.
      const forged = yield* withRules(
        runtime,
        scopeB,
      )((persistence) => persistence.createTaxRule({ ...createInput, ...invocation(scopeA) })).pipe(Effect.exit);
      expect(Exit.isFailure(forged)).toBe(true);
    }),
  ),
);

it.live('#929 F2 #930 F8 Tax Rule revisions and facts are immutable for the runtime role', () =>
  Effect.scoped(
    Effect.gen(function* taxRuleImmutability() {
      const { runtime } = yield* acquireDatabases;
      const createInput = { ...(yield* createRulePayload('cz.immutable', content())), ...invocation(scopeA) };
      const created = yield* withRules(
        runtime,
        scopeA,
      )((persistence) => persistence.createTaxRule(createInput)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
      );
      const update = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction
          .update(taxRuleRevisions)
          .set({ ratePercent: '12' })
          .where(eq(taxRuleRevisions.taxRuleRevisionId, created.initialRevisionId)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(update)).toBe(true);
      const remove = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction.delete(taxRules).where(eq(taxRules.taxRuleId, created.taxRuleId)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(remove)).toBe(true);
      const stored = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction
          .select({ ratePercent: taxRuleRevisions.ratePercent })
          .from(taxRuleRevisions)
          .where(
            and(
              eq(taxRuleRevisions.tenantId, tenantId),
              eq(taxRuleRevisions.taxRuleRevisionId, created.initialRevisionId),
            ),
          ),
      );
      expect(stored).toEqual([{ ratePercent: '21' }]);
    }),
  ),
);

it.live(
  '#949 F22-F32 competing System-of-Record authority is rejected from the complete set and never resolved newest-wins',
  () =>
    Effect.scoped(
      Effect.gen(function* taxFactAuthorityAcceptance() {
        const { admin, runtime } = yield* acquireDatabases;
        const authority = withAuthority(runtime, scopeA);
        const reads = withReads(runtime, scopeA);
        const currentAt = (instant: string) =>
          authorityRequest(instant).pipe(
            Effect.flatMap((request) => reads((read) => read.taxFactAuthorityCurrent(request))),
          );

        const firstInput = {
          ...(yield* establishPayload('vat-registration.party', '2026-01-01T00:00:00.000Z', 'party.registry')),
          ...invocation(scopeA),
        };
        const first = yield* authority((persistence) => persistence.establishContract(firstInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ContractOutcomeSchema)),
        );
        expect(first).toMatchObject({ created: true, revisionNumber: 1 });
        const firstReplay = yield* authority((persistence) => persistence.establishContract(firstInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ContractOutcomeSchema)),
        );
        expect(firstReplay).toEqual({ ...first, created: false });

        // A second System of Record for the same fact family at a shared instant is an authority conflict.
        const erpInput = {
          ...(yield* establishPayload('vat-registration.erp', '2026-06-01T00:00:00.000Z', 'erp.vat-ledger')),
          ...invocation(scopeA),
        };
        const competing = yield* authority((persistence) => persistence.establishContract(erpInput));
        expect(competing).toEqual({ conflict: 'AUTHORITY_CONFLICT', kind: 'conflict' });

        const established = yield* currentAt('2026-06-01T00:00:00.000Z');
        expect(established.outcome).toBe('AUTHORITY_ESTABLISHED');
        const reviseInput = {
          ...(yield* Schema.decodeEffect(ReviseTaxFactAuthorityContractPayloadSchema)({
            authority: {
              authorityFrom: '2026-01-01T00:00:00.000Z',
              evidenceSourceRefs: ['tax.vies-check', 'tax.ares-check'],
              systemOfRecordRef: 'party.registry',
            },
            contractRef: contractRef(first.contractId),
            expectedBasisFingerprint: '0'.repeat(64),
            provenanceRef: 'acceptance:revise',
            reason: 'Add ARES evidence role',
          })),
          ...invocation(scopeA),
        };
        const staleRevise = yield* authority((persistence) => persistence.reviseContract(reviseInput));
        expect(staleRevise).toEqual({ kind: 'stale_basis' });

        // #949 F30-F32 F44 revising never moves the System of Record or the authority window; that would rewrite
        // past authority or leave the present without one. A transition is an end plus a successor contract.
        const currentBasis = established.authorities[0]?.basisFingerprint ?? '';
        for (const authorityChange of [
          { ...reviseInput.authority, systemOfRecordRef: 'erp.vat-ledger' },
          { ...reviseInput.authority, authorityFrom: DateTime.makeUnsafe('2025-01-01T00:00:00.000Z') },
          { ...reviseInput.authority, authorityTo: DateTime.makeUnsafe('2027-01-01T00:00:00.000Z') },
        ]) {
          const moved = yield* authority((persistence) =>
            persistence.reviseContract({
              ...reviseInput,
              ...invocation(scopeA),
              authority: authorityChange,
              expectedBasisFingerprint: currentBasis,
            }),
          );
          expect(moved).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });
        }
        const revised = yield* authority((persistence) =>
          persistence.reviseContract({
            ...reviseInput,
            expectedBasisFingerprint: established.authorities[0]?.basisFingerprint ?? '',
          }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ContractOutcomeSchema)));
        expect(revised).toMatchObject({ created: true, revisionNumber: 2 });

        const revisedBasis = (yield* currentAt('2026-06-01T00:00:00.000Z')).authorities[0]?.basisFingerprint ?? '';
        const endInput = {
          ...(yield* Schema.decodeEffect(EndTaxFactAuthorityContractPayloadSchema)({
            authorityTo: '2027-01-01T00:00:00.000Z',
            contractRef: contractRef(first.contractId),
            expectedBasisFingerprint: revisedBasis,
            provenanceRef: 'acceptance:end-authority',
            reason: 'Authority moves to the ERP ledger',
          })),
          ...invocation(scopeA),
        };
        // #929 F19 #949 F16-F17 authority is never ended before the trusted operation time.
        const backdatedEnd = yield* authority((persistence) =>
          persistence.endContract({
            ...endInput,
            ...invocation(scopeA),
            authorityTo: DateTime.makeUnsafe('2026-01-15T00:00:00.000Z'),
          }),
        );
        expect(backdatedEnd).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });
        const ended = yield* authority((persistence) => persistence.endContract(endInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ContractOutcomeSchema)),
        );
        expect(ended).toMatchObject({ created: true, revisionNumber: 3 });

        const successorInput = {
          ...(yield* establishPayload('vat-registration.erp', '2027-01-01T00:00:00.000Z', 'erp.vat-ledger')),
          ...invocation(scopeA),
        };
        const successor = yield* authority((persistence) => persistence.establishContract(successorInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ContractOutcomeSchema)),
        );
        expect(successor.created).toBe(true);
        expect((yield* currentAt('2026-12-31T23:59:59.999Z')).authorities[0]?.systemOfRecordRef).toBe('party.registry');
        expect((yield* currentAt('2027-01-01T00:00:00.000Z')).authorities[0]?.systemOfRecordRef).toBe('erp.vat-ledger');

        // State written around the governed path still cannot produce a newest-wins answer.
        const outOfBandId = randomUUID();
        const attribution = {
          actionInvocationId: outOfBandId,
          actorPrincipalId: principalId,
          idempotencyKey: outOfBandId,
          legalEntityId: sellerA,
          provenanceRef: 'acceptance:out-of-band',
          reason: 'Out-of-band competitor',
          tenantId,
        };
        const competitorFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2027-06-01T00:00:00.000Z'));
        yield* admin.transaction((transaction) =>
          Effect.gen(function* insertOutOfBandCompetitor() {
            const [contract] = yield* transaction
              .insert(taxFactAuthorityContracts)
              .values({
                ...attribution,
                factFamily: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
                stableCode: 'vat-registration.out-of-band',
              })
              .returning({ contractId: taxFactAuthorityContracts.taxFactAuthorityContractId });
            yield* transaction.insert(taxFactAuthorityContractRevisions).values({
              ...attribution,
              authorityFrom: competitorFrom,
              evidenceSourceRefs: [],
              revisionNumber: 1,
              semanticFingerprint: 'f'.repeat(64),
              systemOfRecordRef: 'crm.vat-notes',
              taxFactAuthorityContractId: contract?.contractId ?? '',
            });
          }),
        );
        const conflicted = yield* currentAt('2027-07-01T00:00:00.000Z');
        expect(conflicted.outcome).toBe('AUTHORITY_CONFLICT');
        expect(conflicted.authorities.map(({ systemOfRecordRef }) => systemOfRecordRef).toSorted()).toEqual([
          'crm.vat-notes',
          'erp.vat-ledger',
        ]);
        expect((yield* currentAt('2025-01-01T00:00:00.000Z')).outcome).toBe('AUTHORITY_MISSING');
      }),
    ),
);

it.live(
  '#930 F6-F7 #942 F15 F18 a correction committed during a governed read is wholly visible or wholly absent, never torn',
  () =>
    Effect.scoped(
      Effect.gen(function* tornReadAcceptance() {
        const { adminClient, runtime } = yield* acquireDatabases;
        const createInput = { ...(yield* createRulePayload('cz.torn-read', content())), ...invocation(scopeA) };
        const created = yield* withRules(
          runtime,
          scopeA,
        )((persistence) => persistence.createTaxRule(createInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
        );

        // A concurrent writer holds the correction table and commits a correcting revision plus its provenance.
        const connections = yield* loadDatabaseConnectionPair();
        const writer = yield* makeTestPgSession(connections.admin.connectionString);
        yield* writer.unsafe('BEGIN');
        yield* Effect.addFinalizer(() => writer.unsafe('ROLLBACK').pipe(Effect.orDie));
        const [writerBackend] = yield* writer.unsafe<{ pid: number }>('select pg_backend_pid() as pid');
        const writerPid = yield* Schema.decodeUnknownEffect(Schema.Finite)(writerBackend?.pid);
        yield* writer.unsafe('lock table tax.tax_rule_corrections in access exclusive mode');
        const correctingRevisionId = randomUUID();
        const correctionInvocation = randomUUID();
        yield* writer.unsafe(
          `insert into tax.tax_rule_revisions (tax_rule_revision_id, tenant_id, legal_entity_id, composition_kind,
             effective_from, jurisdiction, rate_percent, revision_number, semantic_fingerprint, supersedes_revision_id,
             tax_classification_code, tax_rule_id, treatment_category, action_invocation_id, actor_principal_id,
             idempotency_key, provenance_ref, reason)
           values ($1, $2, $3, 'EXCLUSIVE', '2026-01-01T00:00:00.000Z', 'CZ_DOMESTIC', '12', 2, $4, $5,
             'cz-standard-goods', $6, 'TAXABLE', $7::uuid, $8, $7::text, 'acceptance:torn-read',
             'Concurrent correction')`,
          [
            correctingRevisionId,
            tenantId,
            sellerA,
            'e'.repeat(64),
            created.initialRevisionId,
            created.taxRuleId,
            correctionInvocation,
            principalId,
          ],
        );
        yield* writer.unsafe(
          `insert into tax.tax_rule_corrections (tenant_id, legal_entity_id, confirmed_at, correcting_revision_id,
             wrong_revision_id, action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason)
           values ($1, $2, '2026-02-01T00:00:00.000Z', $3, $4, $5::uuid, $6, $5::text, 'acceptance:torn-read',
             'Concurrent correction')`,
          [tenantId, sellerA, correctingRevisionId, created.initialRevisionId, correctionInvocation, principalId],
        );

        const reader = yield* applicableRequest('2026-06-01T00:00:00.000Z').pipe(
          Effect.flatMap((request) => withReads(runtime, scopeA)((read) => read.applicableTaxRuleSet(request))),
          Effect.forkChild,
        );
        // The writer commits only while the read is waiting inside its observation of the predicate state.
        expect(yield* awaitBlockedBehind(adminClient, writerPid)).toBe(true);
        yield* writer.unsafe('COMMIT');
        const observed = yield* Fiber.join(reader);

        expect(observed.completeness.rowCount).toBe(2);
        expect(observed.outcome).toBe('SELECTED');
        expect(observed.applicable.map(({ taxRuleRevisionRef }) => taxRuleRevisionRef.resourceId)).toEqual([
          correctingRevisionId,
        ]);
        expect(observed.excludedByCorrection.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
          created.initialRevisionId,
        ]);
      }),
    ),
);

it.live(
  '#929 F8 F19 #930 F8-F9 #949 F16-F19 F45 #955 Tax Rule lifecycle is never backdated, withdraws scheduled revisions and never revives corrected ones',
  () =>
    Effect.scoped(
      Effect.gen(function* taxRuleLifecycleAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const rules = withRules(runtime, scopeA);
        const history = ruleHistory(runtime, scopeA);
        const applicableAt = applicableSet(runtime, scopeA);
        const createRule = (stableCode: string, classification: string) =>
          Effect.gen(function* createLifecycleRule() {
            const input = {
              ...(yield* createRulePayload(stableCode, content({ taxClassificationCode: classification }))),
              ...invocation(scopeA),
            };
            return yield* rules((persistence) => persistence.createTaxRule(input)).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
            );
          });
        const endInput = (revisionId: string, endedEffectiveTo: string, expectedBasisFingerprint: string) =>
          Effect.gen(function* endLifecycleInput() {
            return {
              ...(yield* Schema.decodeEffect(EndTaxRuleRevisionPayloadSchema)({
                endedEffectiveTo,
                expectedBasisFingerprint,
                provenanceRef: 'acceptance:lifecycle-end',
                reason: 'Lifecycle end',
                taxRuleRevisionRef: revisionRef(revisionId),
              })),
              ...invocation(scopeA),
            };
          });
        const revisionInput = (
          taxRuleId: string,
          revisionContent: ReturnType<typeof content>,
          expectedBasisFingerprint: string,
          replacesRevisionId?: string,
        ) =>
          Effect.gen(function* revisionLifecycleInput() {
            const payload = {
              content: revisionContent,
              expectedBasisFingerprint,
              provenanceRef: 'acceptance:lifecycle-revision',
              reason: 'Lifecycle revision',
              taxRuleRef: ruleRef(taxRuleId),
            };
            const withReplacement =
              replacesRevisionId === undefined
                ? payload
                : { ...payload, replacesRevisionRef: revisionRef(replacesRevisionId) };
            return {
              ...(yield* Schema.decodeEffect(CreateTaxRuleRevisionPayloadSchema)(withReplacement)),
              ...invocation(scopeA),
            };
          });

        const rule = yield* createRule('cz.lifecycle', 'cz-standard-goods');
        const rev1 = rule.initialRevisionId;

        // #929 F19 #949 F16-F17 an end before the trusted operation time is a retroactive change, not an end.
        const backdated = yield* endInput(
          rev1,
          '2026-01-15T00:00:00.000Z',
          (yield* history(rule.taxRuleId)).basisFingerprint,
        );
        expect(yield* rules((persistence) => persistence.endTaxRuleRevision(backdated))).toEqual({
          conflict: 'LIFECYCLE',
          kind: 'conflict',
        });

        const rev2Input = yield* revisionInput(
          rule.taxRuleId,
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '23' }),
          (yield* history(rule.taxRuleId)).basisFingerprint,
        );
        const rev2 = yield* rules((persistence) => persistence.createTaxRuleRevision(rev2Input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)),
        );

        // #929 F8 #949 D a scheduled revision that is not effective yet is withdrawn by an empty end.
        const withdraw = yield* endInput(
          rev2.revisionId,
          '2027-01-01T00:00:00.000Z',
          (yield* history(rule.taxRuleId)).basisFingerprint,
        );
        expect(
          (yield* rules((persistence) => persistence.endTaxRuleRevision(withdraw)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
          )).ended,
        ).toBe(true);
        expect((yield* applicableAt('2027-06-01T00:00:00.000Z')).applicable[0]?.taxRuleRevisionRef.resourceId).toBe(
          rev1,
        );

        // #949 F45 replacement provenance names a revision of the same Tax Rule and is echoed by history.
        const other = yield* createRule('cz.lifecycle-other', 'cz-reduced-books');
        const crossRule = yield* revisionInput(
          rule.taxRuleId,
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '22' }),
          (yield* history(rule.taxRuleId)).basisFingerprint,
          other.initialRevisionId,
        );
        expect(yield* rules((persistence) => persistence.createTaxRuleRevision(crossRule))).toEqual({
          conflict: 'LIFECYCLE',
          kind: 'conflict',
        });
        const basisBeforeReplacement = (yield* history(rule.taxRuleId)).basisFingerprint;
        const rev3Input = yield* revisionInput(
          rule.taxRuleId,
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '22' }),
          basisBeforeReplacement,
          rev2.revisionId,
        );
        const rev3 = yield* rules((persistence) => persistence.createTaxRuleRevision(rev3Input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)),
        );
        const afterReplacement = yield* history(rule.taxRuleId);
        expect(afterReplacement.revisions[2]?.supersedesRevisionRef).toEqual(Option.some(revisionRef(rev2.revisionId)));
        expect(afterReplacement.meaningKind).toBe('VAT_RATE');
        expect(afterReplacement.revisions[2]?.jurisdiction).toBe('CZ_DOMESTIC');

        // #949 F19 ending is guarded by the whole-rule basis: an intervening revision makes the earlier basis stale.
        const staleEnd = yield* endInput(rev1, '2027-01-01T00:00:00.000Z', basisBeforeReplacement);
        expect(yield* rules((persistence) => persistence.endTaxRuleRevision(staleEnd))).toEqual({
          kind: 'stale_basis',
        });
        const rev1End = yield* endInput(rev1, '2027-01-01T00:00:00.000Z', afterReplacement.basisFingerprint);
        expect(
          (yield* rules((persistence) => persistence.endTaxRuleRevision(rev1End)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
          )).ended,
        ).toBe(true);

        // #930 F8-F9 #949 F47 a correction replaces the wrong revision for exactly its Effective Period.
        const correctInput = (
          correctingContent: ReturnType<typeof content>,
          expectedBasisFingerprint: string,
          wrongRevisionId: string = rev3.revisionId,
        ) =>
          Effect.gen(function* correctLifecycleInput() {
            return {
              ...(yield* Schema.decodeEffect(CorrectTaxRuleRevisionPayloadSchema)({
                confirmedAt: '2026-02-01T00:00:00.000Z',
                correctingContent,
                expectedBasisFingerprint,
                provenanceRef: 'acceptance:lifecycle-correction',
                reason: 'Announced rate was wrong',
                wrongRevisionRef: revisionRef(wrongRevisionId),
              })),
              ...invocation(scopeA),
            };
          });
        const basisBeforeCorrection = (yield* history(rule.taxRuleId)).basisFingerprint;
        for (const partial of [
          content({ effectiveFrom: '2027-06-01T00:00:00.000Z', ratePercent: '21' }),
          content({
            effectiveFrom: '2027-01-01T00:00:00.000Z',
            effectiveTo: '2028-01-01T00:00:00.000Z',
            ratePercent: '21',
          }),
          // Starting earlier would overlap the neighbouring revision 1 and rewrite its history.
          content({ effectiveFrom: '2026-06-01T00:00:00.000Z', ratePercent: '21' }),
        ]) {
          const partialInput = yield* correctInput(partial, basisBeforeCorrection);
          expect(yield* rules((persistence) => persistence.correctTaxRuleRevision(partialInput))).toEqual({
            conflict: 'LIFECYCLE',
            kind: 'conflict',
          });
        }
        const fullInput = yield* correctInput(
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '21' }),
          basisBeforeCorrection,
        );
        const corrected = yield* rules((persistence) => persistence.correctTaxRuleRevision(fullInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CorrectedSchema)),
        );

        // Ending the correcting revision leaves a gap; the confirmed-wrong revision is never revived (#949 F16).
        const endCorrecting = yield* endInput(
          corrected.correctingRevisionId,
          '2028-01-01T00:00:00.000Z',
          (yield* history(rule.taxRuleId)).basisFingerprint,
        );
        yield* rules((persistence) => persistence.endTaxRuleRevision(endCorrecting)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
        );
        const gap = yield* applicableAt('2028-06-01T00:00:00.000Z');
        expect(gap.outcome).toBe('TAX_RULE_MISSING');
        expect(gap.excludedByCorrection.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
          rev3.revisionId,
        ]);

        // #949 F47 correcting the now-bounded correcting revision never fills the MISSING gap after its end.
        const basisAfterEnd = (yield* history(rule.taxRuleId)).basisFingerprint;
        for (const overshoot of [
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '20' }),
          content({
            effectiveFrom: '2027-01-01T00:00:00.000Z',
            effectiveTo: '2029-01-01T00:00:00.000Z',
            ratePercent: '20',
          }),
        ]) {
          const overshootInput = yield* correctInput(overshoot, basisAfterEnd, corrected.correctingRevisionId);
          expect(yield* rules((persistence) => persistence.correctTaxRuleRevision(overshootInput))).toEqual({
            conflict: 'LIFECYCLE',
            kind: 'conflict',
          });
        }
        expect((yield* applicableAt('2028-06-01T00:00:00.000Z')).outcome).toBe('TAX_RULE_MISSING');

        // An already-corrected revision is never corrected again, even for exactly its period (#930 F8).
        const recorrect = yield* correctInput(
          content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '20' }),
          basisAfterEnd,
        );
        expect(yield* rules((persistence) => persistence.correctTaxRuleRevision(recorrect))).toEqual({
          conflict: 'LIFECYCLE',
          kind: 'conflict',
        });

        // The exact period of the bounded correcting revision, including its end fact, is a valid correction.
        const exactInput = yield* correctInput(
          content({
            effectiveFrom: '2027-01-01T00:00:00.000Z',
            effectiveTo: '2028-01-01T00:00:00.000Z',
            ratePercent: '20',
          }),
          basisAfterEnd,
          corrected.correctingRevisionId,
        );
        yield* rules((persistence) => persistence.correctTaxRuleRevision(exactInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CorrectedSchema)),
        );
        expect((yield* applicableAt('2027-06-01T00:00:00.000Z')).applicable[0]?.ratePercent).toBe('20');
        expect((yield* applicableAt('2028-06-01T00:00:00.000Z')).outcome).toBe('TAX_RULE_MISSING');

        // #955 G a replay arriving after newer unrelated revisions still returns its original outcome.
        const replayed = yield* rules((persistence) => persistence.createTaxRuleRevision(rev2Input)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)),
        );
        expect(replayed).toEqual({ ...rev2, created: false });
        const replayedEnd = yield* rules((persistence) => persistence.endTaxRuleRevision(rev1End)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(EndedRevisionSchema)),
        );
        expect(replayedEnd).toEqual({ ended: false, revisionId: rev1 });
      }),
    ),
);

it.live(
  '#949 F20 #955 concurrent writers with the same expected-current basis: exactly one wins, the other is stale',
  () =>
    Effect.scoped(
      Effect.gen(function* concurrentStaleBasis() {
        const { adminClient, runtime } = yield* acquireDatabases;
        const rules = withRules(runtime, scopeA);
        const createInput = { ...(yield* createRulePayload('cz.concurrent', content())), ...invocation(scopeA) };
        const rule = yield* rules((persistence) => persistence.createTaxRule(createInput)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
        );
        const basis = Option.getOrThrow(
          yield* withReads(runtime, scopeA)((read) => read.taxRuleHistory({ taxRuleRef: ruleRef(rule.taxRuleId) })),
        ).basisFingerprint;
        const revisionPayload = yield* Schema.decodeEffect(CreateTaxRuleRevisionPayloadSchema)({
          content: content({ effectiveFrom: '2027-01-01T00:00:00.000Z', ratePercent: '23' }),
          expectedBasisFingerprint: basis,
          provenanceRef: 'acceptance:concurrent',
          reason: 'Concurrent revision',
          taxRuleRef: ruleRef(rule.taxRuleId),
        });

        const firstWrote = yield* Deferred.make<boolean>();
        const releaseFirst = yield* Deferred.make<boolean>();
        const first = yield* rules((persistence) =>
          persistence.createTaxRuleRevision({ ...revisionPayload, ...invocation(scopeA) }).pipe(
            Effect.tap(() => Deferred.succeed(firstWrote, true)),
            Effect.tap(() => Deferred.await(releaseFirst)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(firstWrote);
        const second = yield* rules((persistence) =>
          persistence.createTaxRuleRevision({ ...revisionPayload, ...invocation(scopeA) }),
        ).pipe(Effect.forkChild);
        // The second writer is parked on the Tax Rule lock while the first is still uncommitted.
        expect(yield* awaitRuleLockWaiter(adminClient)).toBe(true);
        yield* Deferred.succeed(releaseFirst, true);

        const won = yield* Fiber.join(first).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreatedRevisionSchema)));
        expect(won).toMatchObject({ created: true, revisionNumber: 2 });
        expect(yield* Fiber.join(second)).toEqual({ kind: 'stale_basis' });
      }),
    ),
);
