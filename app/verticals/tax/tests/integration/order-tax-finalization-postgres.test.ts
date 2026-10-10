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
import { DeclareSellerVatRegimePayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import {
  TaxRuleMissingSchema,
  TaxStateIndeterminateSchema,
} from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';
import {
  taxOrderTaxFinalizations,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { taxGovernedReadsForScope } from '../../src/services/tax-governed-read.service.ts';
import { orderTaxFinalizationsForScope } from '../../src/services/order-tax-finalization.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { occurrenceInput, purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import { evaluationRequestInput } from '../unit/tax-evaluation-fixtures.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
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
      yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenantId));
      yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenantId));
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
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

type EffectivePeriodInput = Readonly<{ effectiveFrom: string; effectiveTo?: string }>;
const LAUNCH_PERIOD: EffectivePeriodInput = { effectiveFrom: '2026-01-01T00:00:00.000Z' };

const RuleIdSchema = Schema.String.pipe(Schema.brand('TaxTestRuleId'));
const RevisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestRevisionId'));
const DecisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestDecisionId'));
const CreatedRuleSchema = Schema.Struct({ initialRevisionId: RevisionIdSchema, taxRuleId: RuleIdSchema });

/** One seller with governed TAX state, set up through the same owner services the Actions use. */
const seller = (runtime: CoreTestDatabase) => {
  const legalEntityId = randomUUID();
  const scope = scopeFor(legalEntityId);
  const setUp = Effect.gen(function* setUpSeller() {
    const declaration = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared Czech VAT payer',
      regime: 'VAT_PAYER',
    });
    yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
        ...declaration,
        ...invocation(scope),
      }),
    );
  });
  const createRule = (
    stableCode: string,
    taxClassificationCode: string,
    ratePercent: string,
    period: EffectivePeriodInput = LAUNCH_PERIOD,
  ) =>
    Schema.decodeEffect(CreateTaxRulePayloadSchema)({
      initialRevision: {
        compositionKind: 'EXCLUSIVE',
        ...period,
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
  const declare = (
    overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {},
    actionInvocationId: string = randomUUID(),
  ) =>
    Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
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
  return { createRule, declare, finalize, finalOrderTax, launchRules, legalEntityId, payload, scope, setUp };
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
  handoff: Schema.Struct({
    outcome: Schema.Struct({
      decision: Schema.Struct({
        decisionId: DecisionIdSchema,
        declarationRevisionRef: Schema.Struct({ revision: Schema.Finite }),
        sellerVatRegime: Schema.Literals(['VAT_PAYER', 'NON_PAYER']),
      }),
    }),
  }),
});
const finalizedOf = (outcome: FinalizeOutcome) => Schema.decodeUnknownSync(FinalizedSchema)(resultOf(outcome));
const RejectedSchema = Schema.TaggedStruct('FINALIZATION_REJECTED', { reasons: Schema.Array(Schema.String) });
const NotFinalizedSchema = Schema.TaggedStruct('NOT_FINALIZED', { outcome: Schema.Struct({ _tag: Schema.String }) });
const DeclaredSchema = Schema.TaggedStruct('DECLARED', { created: Schema.Boolean, revision: Schema.Finite });
const declaredOf = (outcome: Effect.Success<ReturnType<ReturnType<typeof seller>['declare']>>) => {
  if ('kind' in outcome) {
    throw new Error(`Expected a declaration result, got ${outcome.kind}`);
  }
  return Schema.decodeUnknownSync(DeclaredSchema)(outcome.result);
};

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
      // The stored final's Decision carries its own sellerVatRegime and declarationRevisionRef (#943/#950).
      expect(first.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(first.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);
      const created = resultOf(yield* subject.finalize(subject.payload(submission), invocationId));
      // Core-invocation replay of the same request echoes the original (#955 G).
      expect(finalizedOf(yield* subject.finalize(subject.payload(submission), invocationId)).created).toBe(false);
      // The same Core invocation carrying another submission is a reused key, never a second final (#955 G).
      expect(yield* subject.finalize(subject.payload(`submission-${randomUUID()}`), invocationId)).toEqual({
        conflict: 'IDEMPOTENCY_REUSED',
        kind: 'conflict',
      });

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

      // Another seller of the same tenant, or the same seller id under another tenant, cannot see the final.
      expect(Option.isNone(yield* subject.finalOrderTax(submission, scopeFor(randomUUID())))).toBe(true);
      expect(
        Option.isNone(yield* subject.finalOrderTax(submission, scopeFor(subject.legalEntityId, randomUUID()))),
      ).toBe(true);
      // A candidate naming another seller is invisible, even under a submission that already has a final.
      const foreignCandidate = subject.payload(submission, {
        purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: randomUUID(), tenantId }),
      });
      expect(yield* subject.finalize(foreignCandidate)).toEqual({ kind: 'not_found' });

      // A future T is rejected, never evaluated, and stores nothing (#941 F3, step-5 FUTURE_TAX_RELEVANT_TIME).
      const futureSubmission = `submission-${randomUUID()}`;
      const future = resultOf(
        yield* subject.finalize(subject.payload(futureSubmission, {}, '2099-01-01T00:00:00.000Z')),
      );
      expect((yield* Schema.decodeUnknownEffect(RejectedSchema)(future)).reasons).toEqual(['FUTURE_TAX_RELEVANT_TIME']);
      expect(Option.isNone(yield* subject.finalOrderTax(futureSubmission))).toBe(true);

      // The stored final is append-only: neither rewritten nor deleted.
      const rewrite = (statement: string) =>
        Effect.exit(adminClient.unsafe(statement, [tenantId, submission])).pipe(Effect.map(Exit.isFailure));
      expect(
        yield* rewrite(
          `update tax.tax_order_tax_finalizations set reason = 'rewritten' where tenant_id = $1 and submission_ref = $2`,
        ),
      ).toBe(true);
      expect(
        yield* rewrite(`delete from tax.tax_order_tax_finalizations where tenant_id = $1 and submission_ref = $2`),
      ).toBe(true);
      expect(Option.isSome(yield* subject.finalOrderTax(submission))).toBe(true);
    }),
  ),
);

it.live('#941 F5 F10 the final selects rules at T, not at the later Tax Evaluation Time', () =>
  Effect.scoped(
    Effect.gen(function* boundaryAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      // A rate boundary after T and before E: [Jan, Aug) at 21 %, [Aug, ...) at 23 %.
      const BOUNDARY = '2026-08-01T00:00:00.000Z';
      const [beforeBoundary, fromBoundary] = yield* Effect.all(
        [
          subject.createRule('cz.standard', 'cz-standard-goods', '21', {
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: BOUNDARY,
          }),
          subject.createRule('cz.standard-august', 'cz-standard-goods', '23', { effectiveFrom: BOUNDARY }),
          subject.createRule('cz.reduced', 'cz-reduced-food', '12'),
        ],
        { concurrency: 1 },
      );
      const governingRulesAt = Effect.fn('governingRulesAt')(function* governingRulesAtEffect(at: string) {
        const submission = `submission-${randomUUID()}`;
        finalizedOf(yield* subject.finalize(subject.payload(submission, {}, at)));
        const { handoff } = Option.getOrThrow(yield* subject.finalOrderTax(submission));
        expect(DateTime.formatIso(handoff.outcome.decision.taxRelevantTime)).toBe(at);
        return handoff.outcome.decision.units
          .filter(
            (unit): unit is Extract<typeof unit, { governingTaxRuleRevisionRef: unknown }> =>
              'governingTaxRuleRevisionRef' in unit,
          )
          .map(({ governingTaxRuleRevisionRef }) => governingTaxRuleRevisionRef.taxRuleId);
      });

      expect(yield* governingRulesAt(T)).toContain(beforeBoundary.taxRuleId);
      expect(yield* governingRulesAt(T)).not.toContain(fromBoundary.taxRuleId);
      // Half-open period: T exactly at the boundary belongs to the later rule only.
      expect(yield* governingRulesAt(BOUNDARY)).toContain(fromBoundary.taxRuleId);
      expect(yield* governingRulesAt(BOUNDARY)).not.toContain(beforeBoundary.taxRuleId);
    }),
  ),
);

it.live('Unit 10 C a backdated regime revision recorded after a final leaves the recovered final unchanged', () =>
  Effect.scoped(
    Effect.gen(function* backdatedRecoveryAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${randomUUID()}`;
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(first.created).toBe(true);

      // A later NON_PAYER revision, backdated before T, is recorded after the final; the same-submission recovery
      // reads no seller state and the already-stored Decision is unchanged (Unit 10 C; #942 H, #944 F20).
      const declared = declaredOf(
        yield* subject.declare(
          {
            confirmReplacesScheduled: true,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            expectedCurrentRevision: 1,
            reason: 'Backdated non-payer declaration after finalization',
            regime: 'NON_PAYER',
          },
          randomUUID(),
        ),
      );
      expect(declared.created).toBe(true);

      const recovered = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(recovered.created).toBe(false);
      expect(recovered.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(recovered.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(recovered.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);
    }),
  ),
);

it.live('Unit 10 C a NON_PAYER final stores zero tax with no governing rule revisions', () =>
  Effect.scoped(
    Effect.gen(function* nonPayerFinalizationAcceptance() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      // Non-payer from the start: no setUp() VAT_PAYER declaration, so no rules need to exist.
      yield* subject.declare({ reason: 'Non-payer seller from launch', regime: 'NON_PAYER' });

      const submission = `submission-${randomUUID()}`;
      const final = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(final.created).toBe(true);
      expect(final.handoff.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
      expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);

      const rows = yield* adminClient.unsafe(
        `select outcome -> 'result' -> 'purchaseTaxTotal' ->> 'amount' as purchase_tax_total_amount,
                governing_rule_revisions
         from tax.tax_order_tax_finalizations
         where tenant_id = $1 and submission_ref = $2`,
        [tenantId, submission],
      );
      expect(rows).toEqual([{ governing_rule_revisions: [], purchase_tax_total_amount: '0.00' }]);
    }),
  ),
);

it.live('Unit 10 C a seller with nothing declared cannot finalize', () =>
  Effect.scoped(
    Effect.gen(function* notDeclaredFinalizationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      // Deliberately skip setUp(): no VAT regime has ever been declared for this seller.
      const submission = `submission-${randomUUID()}`;

      const notFinalized = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(
        resultOf(yield* subject.finalize(subject.payload(submission))),
      );
      expect(notFinalized.outcome).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);
    }),
  ),
);

it.live('Unit 10 C a declare concurrent with finalize serializes on the seller lock', () =>
  Effect.scoped(
    Effect.gen(function* concurrentDeclareAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${randomUUID()}`;
      const [finalizeOutcome, declareOutcome] = yield* Effect.all(
        [
          subject.finalize(subject.payload(submission)),
          subject.declare(
            {
              confirmReplacesScheduled: true,
              effectiveFrom: '2026-01-01T00:00:00.000Z',
              expectedCurrentRevision: 1,
              reason: 'Concurrent declaration racing a finalize',
              regime: 'NON_PAYER',
            },
            randomUUID(),
          ),
        ],
        { concurrency: 2 },
      );
      // Whichever order the seller lock serializes them in, the final's regime is exactly the head at its commit:
      // either the seller's original VAT_PAYER declaration (revision 1, finalize won the lock), or the concurrent
      // NON_PAYER revision (revision 2, declare won it), never a mix (#950 F24, Unit 10 C).
      const final = finalizedOf(finalizeOutcome);
      const declared = declaredOf(declareOutcome);
      expect(declared.created).toBe(true);
      expect(declared.revision).toBe(2);
      const finalizeWonTheLock = final.handoff.outcome.decision.sellerVatRegime === 'VAT_PAYER';
      expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(finalizeWonTheLock ? 1 : 2);
      expect(['VAT_PAYER', 'NON_PAYER']).toContain(final.handoff.outcome.decision.sellerVatRegime);
    }),
  ),
);
