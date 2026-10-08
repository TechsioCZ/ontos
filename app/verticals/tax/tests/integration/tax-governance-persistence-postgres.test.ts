import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
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

const invocation = (scope: OperationalScope) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
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

const applicableRequest = (taxRelevantTime: string) =>
  Schema.decodeEffect(ApplicableTaxRuleSetRequestContractSchema)({
    jurisdiction: 'CZ_DOMESTIC',
    taxClassificationCode: 'cz-standard-goods',
    taxRelevantTime,
  });
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
  return { admin, runtime };
});

it.live(
  '#929 #930 F8 #955 Tax Rule governance replays, rejects reused keys and stale bases, and keeps corrections addressable',
  () =>
    Effect.scoped(
      Effect.gen(function* taxRuleGovernanceAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const rules = withRules(runtime, scopeA);
        const reads = withReads(runtime, scopeA);
        const history = (taxRuleId: string) =>
          reads((read) => read.taxRuleHistory({ taxRuleRef: ruleRef(taxRuleId) })).pipe(Effect.map(Option.getOrThrow));

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

        // Ending is a separate fact guarded by the exact revision basis.
        const firstRevisionBasis = (yield* history(created.taxRuleId)).revisions[0]?.basisFingerprint ?? '';
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
        const endedBasis = (yield* history(created.taxRuleId)).revisions[0]?.basisFingerprint ?? '';
        const endAgain = yield* rules((persistence) =>
          persistence.endTaxRuleRevision({ ...endInput, ...invocation(scopeA), expectedBasisFingerprint: endedBasis }),
        );
        expect(endAgain).toEqual({ conflict: 'LIFECYCLE', kind: 'conflict' });

        // #930 F8 a confirmed correction appends a correcting revision plus provenance atomically.
        const wrongBasis = (yield* history(created.taxRuleId)).revisions[1]?.basisFingerprint ?? '';
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
        expect(evidence.corrections.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
          future.revisionId,
        ]);

        const applicableAt = (taxRelevantTime: string) =>
          applicableRequest(taxRelevantTime).pipe(
            Effect.flatMap((request) => reads((read) => read.applicableTaxRuleSet(request))),
          );
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
