import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
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
  FinalizeOrderTaxPayloadSchema,
  OrderSubmissionRefSchema,
} from '../../shared/actions/order-tax-finalization.ts';
import type { FinalizeOrderTaxResult } from '../../shared/actions/order-tax-finalization.ts';
import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
  EstablishTaxFactAuthorityContractPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import { TaxRuleMissingSchema } from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxOrderTaxFinalizations,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../../src/database/schema.ts';
import { taxAuthorityGovernancePersistenceForScope } from '../../src/services/tax-authority-governance.service.ts';
import { taxGovernedReadsForScope } from '../../src/services/tax-governed-read.service.ts';
import { orderTaxFinalizationsForScope } from '../../src/services/order-tax-finalization.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { taxSourceAssertionPersistenceForScope } from '../../src/services/tax-source-assertion.service.ts';
import { occurrenceInput, purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import { evaluationRequestInput } from '../unit/tax-evaluation-fixtures.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const FACT_FAMILY = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION';
const T = '2026-06-01T10:00:00.000Z';

const scopeFor = (legalEntityId: string, tenant = tenantId): OperationalScope => ({
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
    Effect.gen(function* cleanupOrderTaxRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(taxOrderTaxFinalizations).where(eq(taxOrderTaxFinalizations.tenantId, tenantId));
      yield* transaction.delete(taxSourceConflicts).where(eq(taxSourceConflicts.tenantId, tenantId));
      yield* transaction.delete(taxSourceAssertions).where(eq(taxSourceAssertions.tenantId, tenantId));
      yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenantId));
      yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenantId));
      yield* transaction
        .delete(taxFactAuthorityContractRevisions)
        .where(eq(taxFactAuthorityContractRevisions.tenantId, tenantId));
      yield* transaction.delete(taxFactAuthorityContracts).where(eq(taxFactAuthorityContracts.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireOrderTaxTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { adminClient, runtime };
});

const RuleIdSchema = Schema.String.pipe(Schema.brand('TaxTestRuleId'));
const RevisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestRevisionId'));
const DecisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestDecisionId'));
const CreatedRuleSchema = Schema.Struct({ initialRevisionId: RevisionIdSchema, taxRuleId: RuleIdSchema });

/** One seller with governed TAX state, set up through the same owner services the Actions use. */
const seller = (runtime: CoreTestDatabase) => {
  const legalEntityId = randomUUID();
  const scope = scopeFor(legalEntityId);
  const setUp = Effect.gen(function* setUpSeller() {
    const authority = yield* Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
      authority: {
        authorityFrom: '2026-01-01T00:00:00.000Z',
        evidenceSourceRefs: [],
        systemOfRecordRef: 'erp.finance',
      },
      factFamily: FACT_FAMILY,
      provenanceRef: 'acceptance:authority',
      reason: 'Govern VAT registration authority',
      stableCode: 'cz.vat-registration',
    });
    yield* runScoped(runtime, scope, (transaction) =>
      taxAuthorityGovernancePersistenceForScope(transaction, scope).establishContract({
        ...authority,
        ...invocation(scope),
      }),
    );
    const registration = yield* Schema.decodeEffect(RecordTaxSourceAssertionPayloadSchema)({
      factFamily: FACT_FAMILY,
      jurisdiction: 'CZ_DOMESTIC',
      provenanceRef: 'acceptance:registration',
      reason: 'Record seller VAT registration evidence',
      registrationMeaning: 'REGISTERED',
      sourceAssertionKey: 'erp-assertion-1',
      sourceRecordRef: 'erp-record-1',
      sourceRef: 'erp.finance',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    yield* runScoped(runtime, scope, (transaction) =>
      taxSourceAssertionPersistenceForScope(transaction, scope).recordAssertion({
        ...registration,
        ...invocation(scope),
      }),
    );
  });
  const createRule = (stableCode: string, taxClassificationCode: string, ratePercent: string) =>
    Schema.decodeEffect(CreateTaxRulePayloadSchema)({
      initialRevision: {
        compositionKind: 'EXCLUSIVE',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        jurisdiction: 'CZ_DOMESTIC',
        ratePercent,
        taxClassificationCode,
        treatmentCategory: 'TAXABLE',
      },
      meaningKind: 'VAT_RATE',
      provenanceRef: `acceptance:${stableCode}`,
      reason: 'Czech VAT rate',
      stableCode,
    }).pipe(
      Effect.flatMap((payload) =>
        runScoped(runtime, scope, (transaction) =>
          taxRuleGovernancePersistenceForScope(transaction, scope).createTaxRule({ ...payload, ...invocation(scope) }),
        ),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
    );
  const launchRules = Effect.all(
    [createRule('cz.standard', 'cz-standard-goods', '21'), createRule('cz.reduced', 'cz-reduced-food', '12')],
    { concurrency: 1 },
  );
  const payload = (
    submissionRef: string,
    overrides: Parameters<typeof evaluationRequestInput>[0] = {},
    orderCommitmentTime = T,
  ) => {
    const { taxRelevantTime: _taxRelevantTime, ...candidate } = evaluationRequestInput({
      purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
      ...overrides,
    });
    return Schema.decodeSync(FinalizeOrderTaxPayloadSchema)({
      candidate,
      orderCommitmentTime,
      provenanceRef: 'acceptance:finalize',
      reason: 'Final Order Tax at Order Commitment Time',
      submissionRef,
    });
  };
  const finalize = (input: ReturnType<typeof payload>, actionInvocationId: string = randomUUID()) =>
    runScoped(runtime, scope, (transaction) =>
      orderTaxFinalizationsForScope(transaction, scope).finalize({
        ...input,
        ...invocation(scope, actionInvocationId),
      }),
    );
  const finalOrderTax = (submissionRef: string, readScope: OperationalScope = scope) =>
    runScoped(runtime, readScope, (transaction) =>
      orderTaxFinalizationsForScope(transaction, readScope).finalOrderTax({
        submissionRef: OrderSubmissionRefSchema.make(submissionRef),
      }),
    );
  return { createRule, finalize, finalOrderTax, launchRules, legalEntityId, payload, scope, setUp };
};

type FinalizeOutcome = Effect.Success<ReturnType<ReturnType<typeof seller>['finalize']>>;

/** The typed result of an accepted request; a governance conflict or not-found fails the test. */
const resultOf = (outcome: FinalizeOutcome): FinalizeOrderTaxResult => {
  if ('kind' in outcome) {
    throw new Error(`Expected a finalization result, got ${outcome.kind}`);
  }
  return outcome.result;
};

const FinalizedSchema = Schema.TaggedStruct('FINALIZED', {
  created: Schema.Boolean,
  handoff: Schema.Struct({ outcome: Schema.Struct({ decision: Schema.Struct({ decisionId: DecisionIdSchema }) }) }),
});
const finalizedOf = (outcome: FinalizeOutcome) => Schema.decodeUnknownSync(FinalizedSchema)(resultOf(outcome));
const RejectedSchema = Schema.TaggedStruct('FINALIZATION_REJECTED', { reasons: Schema.Array(Schema.String) });
const NotFinalizedSchema = Schema.TaggedStruct('NOT_FINALIZED', { outcome: Schema.Struct({ _tag: Schema.String }) });

it.live('#944 F8-F13 #941 F2-F9 a final Order Tax is fixed at T, stored once and recovered unchanged', () =>
  Effect.scoped(
    Effect.gen(function* finalizationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${randomUUID()}`;
      const invocationId = randomUUID();
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission), invocationId));
      expect(first.created).toBe(true);
      const created = resultOf(yield* subject.finalize(subject.payload(submission), invocationId));
      // Core-invocation replay of the same request echoes the original (#955 G).
      expect(finalizedOf(yield* subject.finalize(subject.payload(submission), invocationId)).created).toBe(false);

      // An ordinary rule change after finalization (here: an overlapping rule) never reopens the final (#942 H,
      // #944 F20): the recovery reads no rule state and returns the same Decision.
      yield* subject.createRule('cz.reduced-duplicate', 'cz-reduced-food', '12');
      const recovered = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(recovered.created).toBe(false);
      expect(recovered.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);

      // The same submission with a changed intent is a conflict, never a second result (#944 F11).
      const changed = yield* subject.finalize(
        subject.payload(submission, {
          purchase: purchaseBindingInput(['o1', 'o2'], {
            purchaseDemandOccurrences: [
              { ...occurrenceInput('o1'), quantity: { amount: '2', unitRef: 'piece' } },
              occurrenceInput('o2'),
            ],
            sellingLegalEntityRef: subject.legalEntityId,
            tenantId,
          }),
        }),
      );
      expect(changed).toEqual({ conflict: 'SUBMISSION_INTENT_CHANGED', kind: 'conflict' });

      // Lost response: the final is recoverable by submission identity alone (#944 F10).
      const read = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(read.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(DateTime.formatIso(read.handoff.outcome.decision.taxRelevantTime)).toBe(T);
      expect(read.handoff.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(read.governingRevisionCorrections).toEqual([]);
      expect(resultOf(yield* subject.finalize(subject.payload(submission)))).toMatchObject({ created: false });
      expect(created).toMatchObject({ created: false });
    }),
  ),
);

it.live('#944 F12 a non-success stores nothing; the same submission finalizes once rules exist', () =>
  Effect.scoped(
    Effect.gen(function* nonSuccessAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      const submission = `submission-${randomUUID()}`;

      const missing = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(
        resultOf(yield* subject.finalize(subject.payload(submission))),
      );
      expect(missing.outcome).toEqual(TaxRuleMissingSchema.make({}));
      expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);

      yield* subject.launchRules;
      expect(finalizedOf(yield* subject.finalize(subject.payload(submission))).created).toBe(true);
    }),
  ),
);

it.live('#930 F11 F13 the final read names a later correction of a governing revision without refreshing it', () =>
  Effect.scoped(
    Effect.gen(function* correctionAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      const [standard] = yield* subject.launchRules;
      const submission = `submission-${randomUUID()}`;
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission)));

      const history = yield* runScoped(runtime, subject.scope, (transaction) =>
        taxGovernedReadsForScope(transaction, subject.scope).taxRuleHistory({
          taxRuleRef: {
            moduleId: 'commerce.tax',
            resourceId: standard.taxRuleId,
            resourceType: 'commerce.tax.tax-rule',
            tenantId,
          },
        }),
      ).pipe(Effect.map(Option.getOrThrow));
      const correction = yield* Schema.decodeEffect(CorrectTaxRuleRevisionPayloadSchema)({
        confirmedAt: '2026-01-15T00:00:00.000Z',
        correctingContent: {
          compositionKind: 'EXCLUSIVE',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          jurisdiction: 'CZ_DOMESTIC',
          ratePercent: '21',
          taxClassificationCode: 'cz-standard-goods',
          treatmentCategory: 'TAXABLE',
        },
        expectedBasisFingerprint: history.basisFingerprint,
        provenanceRef: 'acceptance:correction',
        reason: 'Confirmed wrong for its period',
        wrongRevisionRef: {
          moduleId: 'commerce.tax',
          resourceId: standard.initialRevisionId,
          resourceType: 'commerce.tax.tax-rule-revision',
          tenantId,
        },
      });
      yield* runScoped(runtime, subject.scope, (transaction) =>
        taxRuleGovernancePersistenceForScope(transaction, subject.scope).correctTaxRuleRevision({
          ...correction,
          ...invocation(subject.scope),
        }),
      );

      const read = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(read.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(read.governingRevisionCorrections.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
        standard.initialRevisionId,
      ]);
    }),
  ),
);

it.live('#950 F24 #944 F11 finals are scoped, immutable and converge under concurrent requests', () =>
  Effect.scoped(
    Effect.gen(function* isolationAcceptance() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;
      const submission = `submission-${randomUUID()}`;

      const [left, right] = yield* Effect.all(
        [subject.finalize(subject.payload(submission)), subject.finalize(subject.payload(submission))],
        { concurrency: 2 },
      );
      const ids = [finalizedOf(left), finalizedOf(right)].map(({ handoff }) => handoff.outcome.decision.decisionId);
      expect(new Set(ids).size).toBe(1);
      expect([finalizedOf(left).created, finalizedOf(right).created].filter(Boolean)).toEqual([true]);

      // Another seller of the same tenant cannot see the final.
      const otherSeller = scopeFor(randomUUID());
      expect(Option.isNone(yield* subject.finalOrderTax(submission, otherSeller))).toBe(true);

      // A future T is rejected, never evaluated (#942 F22).
      const future = resultOf(
        yield* subject.finalize(subject.payload(`submission-${randomUUID()}`, {}, '2099-01-01T00:00:00.000Z')),
      );
      expect((yield* Schema.decodeUnknownEffect(RejectedSchema)(future)).reasons).toEqual(['FUTURE_TAX_RELEVANT_TIME']);

      // The stored final is append-only.
      const update = yield* Effect.exit(
        adminClient.unsafe(
          `update tax.tax_order_tax_finalizations set reason = 'rewritten' where tenant_id = $1 and submission_ref = $2`,
          [tenantId, submission],
        ),
      );
      expect(Exit.isFailure(update)).toBe(true);
    }),
  ),
);
