import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { Data, DateTime, Deferred, Effect, Exit, Fiber, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { DomainEventReference, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  FinalOrderTaxHandoffSchema,
  FinalizeOrderTaxPayloadSchema,
  FinalizeOrderTaxResultSchema,
  OrderSubmissionRefSchema,
} from '../../shared/actions/order-tax-finalization.ts';
import { FinalOrderTaxRequestSchema, FinalOrderTaxResponseSchema } from '../../shared/apis/final-order-tax.ts';
import { TaxGovernanceAuditEvidenceSchema } from '../../shared/domain/tax-governance-errors.ts';
import { handleFinalizeOrderTax } from '../../src/actions/finalize-order-tax.action.ts';
import { readFinalOrderTax } from '../../src/api/final-order-tax.read.ts';
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
import {
  PRICING_RESULT_REF,
  evaluationRequestInput,
  grossLine,
  shippingCharge,
} from '../unit/tax-evaluation-fixtures.ts';

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

it.live('PO decision D3 on #907: a final Order Tax with a GROSS Shipping allocation round-trips through recovery', () =>
  Effect.scoped(
    Effect.gen(function* shippingFinalizationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${randomUUID()}`;
      const shippingPayload = subject.payload(submission, {
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
        },
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: subject.legalEntityId,
          shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' },
          tenantId,
        }),
        shipping: { affectedOccurrenceIds: ['o1', 'o2'], source: shippingCharge('99.00') },
      });

      const result = Match.value(resultOf(yield* subject.finalize(shippingPayload))).pipe(
        Match.tag('FINALIZED', (finalized) => finalized),
        Match.orElse((unexpected) => {
          throw new Error(`Expected a FINALIZED result, got ${unexpected._tag}`);
        }),
      );
      expect(result.handoff.outcome.result.purchaseTaxTotal.amount).toBe('47.02');
      // The exact gross-weighted shares and the code-versioned allocation key, not just the rounded published
      // amounts, round-trip through the jsonb Decision store (#907 plan §5.4).
      expect(
        result.handoff.outcome.decision.shippingAllocation?.unitAllocations.map(
          ({ basisComponent, taxableSupplyUnitId }) => [
            taxableSupplyUnitId,
            basisComponent.amount,
            basisComponent.amountBasis,
            basisComponent.allocationKey,
          ],
        ),
      ).toEqual([
        [
          'taxable-supply-unit:o1',
          { denominator: '233', numerator: '11979' },
          'GROSS',
          { key: 'GROSS_LINE_VALUE', revision: 1 },
        ],
        [
          'taxable-supply-unit:o2',
          { denominator: '233', numerator: '11088' },
          'GROSS',
          { key: 'GROSS_LINE_VALUE', revision: 1 },
        ],
      ]);

      // Lost response: same-submission recovery returns the Shipping allocation unchanged (#944 F10).
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(recovered.handoff.outcome.decision.decisionId).toBe(result.handoff.outcome.decision.decisionId);
      expect(recovered.handoff.outcome.decision.shippingAllocation).toEqual(
        result.handoff.outcome.decision.shippingAllocation,
      );
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

/** A controlled crash after the final is inserted and before its owner transaction commits (#963 §3.3). */
class CrashBeforeCommit extends Data.TaggedError('CrashBeforeCommit')<{ readonly reason: string }> {}

it.live(
  '#963 §3.3 a crash after the final insert and before commit leaves no final; the exact retry finalizes once at T',
  () =>
    Effect.scoped(
      Effect.gen(function* crashBeforeDurableFinal() {
        const { adminClient, runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        yield* subject.setUp;
        yield* subject.launchRules;
        const submission = `submission-${randomUUID()}`;
        const invocationId = randomUUID();
        const payload = subject.payload(submission);
        // A raw read past RLS and the owner service: every stored final of the submission, and whether it is at T.
        const storedFinals = adminClient.unsafe<{ at_t: boolean }>(
          `select order_commitment_time = $3::timestamptz as at_t
         from tax.tax_order_tax_finalizations
         where tenant_id = $1 and submission_ref = $2`,
          [tenantId, submission, T],
        );

        // The real finalization service succeeds inside the owner transaction, which then crashes before commit.
        const crash = yield* runScoped(runtime, subject.scope, (transaction) =>
          Effect.gen(function* finalizeThenCrash() {
            const finals = orderTaxFinalizationsForScope(transaction, subject.scope);
            const inserted = finalizedOf(
              yield* finals.finalize({ ...payload, ...invocation(subject.scope, invocationId) }),
            );
            expect(inserted.created).toBe(true);
            const visible = yield* finals.finalOrderTax({ submissionRef: OrderSubmissionRefSchema.make(submission) });
            expect(Option.isSome(visible)).toBe(true);
            return yield* new CrashBeforeCommit({ reason: 'controlled crash before commit' });
          }),
        ).pipe(Effect.flip);
        expect(crash).toBeInstanceOf(CrashBeforeCommit);

        // Nothing became durable: neither recovery nor a raw read finds a final.
        expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);
        expect(yield* storedFinals).toEqual([]);

        // The exact retry (same submission, frozen payload, T and invocation identity) finalizes exactly once at T.
        const retried = finalizedOf(yield* subject.finalize(payload, invocationId));
        expect(retried.created).toBe(true);
        expect(yield* storedFinals).toEqual([{ at_t: true }]);
        const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
        expect(recovered.handoff.outcome.decision.decisionId).toBe(retried.handoff.outcome.decision.decisionId);
        expect(DateTime.formatIso(recovered.handoff.orderCommitmentTime)).toBe(T);
        expect(DateTime.formatIso(recovered.handoff.outcome.decision.taxRelevantTime)).toBe(T);
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
      const { adminClient, runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      // Forced interleaving: the declare takes the seller lock exclusively and holds its transaction open on
      // `release` so the finalize is provably still blocked behind it (not merely racing and happening to win).
      const lockHeld = yield* Deferred.make<null>();
      const release = yield* Deferred.make<null>();
      const declareFiber = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
        confirmReplacesScheduled: true,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        expectedCurrentRevision: 1,
        reason: 'Declaration holding the seller lock during a finalize',
        regime: 'NON_PAYER',
      }).pipe(
        Effect.flatMap((decoded) =>
          runScoped(runtime, subject.scope, (transaction) =>
            sellerVatRegimeDeclarationsForScope(transaction, subject.scope)
              .declare({ ...decoded, ...invocation(subject.scope) })
              .pipe(
                Effect.tap(() => Deferred.succeed(lockHeld, null)),
                Effect.tap(() => Deferred.await(release)),
              ),
          ),
        ),
        Effect.forkChild,
      );

      yield* Deferred.await(lockHeld);
      const submission = `submission-${randomUUID()}`;
      const finalizeFiber = yield* subject.finalize(subject.payload(submission)).pipe(Effect.forkChild);

      // The exclusive advisory xact lock `tax-scope:<tenantId>:<legalEntityId>:SELLER_VAT_REGIME_DECLARATION`
      // (tax-governance-persistence.ts `lockTaxScopeKey`) is held until the declare's transaction commits; finalize
      // takes it `'shared'` only on the evaluating path (order-tax-finalization.service.ts L281), so it must wait.
      const lockKey = `tax-scope:${tenantId}:${subject.legalEntityId}:SELLER_VAT_REGIME_DECLARATION`;
      let waiterSeen = false;
      for (let observation = 0; observation < 50 && !waiterSeen; observation += 1) {
        const [row] = yield* adminClient.unsafe<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
           where locktype = 'advisory' and not granted
             and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
          [lockKey],
        );
        waiterSeen = (row?.waiting ?? 0) >= 1;
        if (!waiterSeen) {
          yield* Effect.sleep('100 millis');
        }
      }
      // A non-granted waiter on that key means the finalize has not completed before the declare's commit: it is
      // genuinely blocked on the seller lock, not merely slower.
      expect(waiterSeen).toBe(true);

      yield* Deferred.succeed(release, null);
      const declareOutcome = yield* Fiber.join(declareFiber);
      const finalizeOutcome = yield* Fiber.join(finalizeFiber);

      // Forced order (Fable MINOR 1): the finalize waits for the declare's commit and then reads its revision,
      // never a mix and never the pre-declare state (#950 F24, Unit 10 C).
      const declared = declaredOf(declareOutcome);
      expect(declared.created).toBe(true);
      expect(declared.revision).toBe(2);
      const final = finalizedOf(finalizeOutcome);
      expect(final.handoff.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
      expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(2);
    }),
  ),
);

/** A Core-shaped Action handler context over real Postgres services; audit evidence is captured, no event is added. */
const actionContext = <Services>(
  scope: OperationalScope,
  services: Services,
  audit: unknown[],
  actionInvocationId: string,
) => {
  // The production collector owns this opaque reference; TAX adds no domain event, so it is never dereferenced.
  const eventReference: DomainEventReference = Schema.decodeSync(Schema.Any)({});
  return {
    actionInvocationId,
    addDomainEvent: () => Effect.succeed(eventReference),
    addOutboxMessage: () => Effect.void,
    compositionRevision: 'c'.repeat(64),
    recordAuditEvidence: (evidence: Readonly<Record<string, Schema.Json>>) => {
      audit.push(evidence);
      return Effect.void;
    },
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
};

it.live('#961 scenario 9: the finalize Action and final read handlers persist, recover and hand off the final', () =>
  Effect.scoped(
    Effect.gen(function* publicFinalizeScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${randomUUID()}`;
      // The wire payload decodes through the public `FinalizeOrderTaxPayloadSchema` (inside `subject.payload`).
      const payload = subject.payload(submission);
      const audit: unknown[] = [];
      const invocationId = randomUUID();
      const finalizeThroughHandler = (actionInvocationId: string) =>
        runScoped(runtime, subject.scope, (transaction) =>
          handleFinalizeOrderTax(
            payload,
            actionContext(
              subject.scope,
              orderTaxFinalizationsForScope(transaction, subject.scope),
              audit,
              actionInvocationId,
            ),
          ),
        ).pipe(
          Effect.flatMap((result) => Schema.encodeEffect(FinalizeOrderTaxResultSchema)(result)),
          Effect.flatMap(Schema.decodeUnknownEffect(FinalizedSchema)),
        );

      const first = yield* finalizeThroughHandler(invocationId);
      expect(first.created).toBe(true);
      // One audit record is captured for the created final (#950 F45-F47).
      expect(yield* Schema.decodeUnknownEffect(Schema.Array(TaxGovernanceAuditEvidenceSchema))(audit)).toHaveLength(1);

      // A retry of the same submission under a new Core invocation recovers the stored final (#944 F10).
      const retry = yield* finalizeThroughHandler(randomUUID());
      expect(retry.created).toBe(false);
      expect(retry.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);

      // Lost-response recovery through the public read handler and its wire schemas.
      const request = yield* Schema.decodeEffect(FinalOrderTaxRequestSchema)({ submissionRef: submission });
      const recovered = yield* runScoped(runtime, subject.scope, (transaction) =>
        readFinalOrderTax(request, {
          readKey: 'commerce.tax.api.final-order-tax',
          scope: subject.scope,
          services: { finalizations: orderTaxFinalizationsForScope(transaction, subject.scope) },
        }),
      ).pipe(
        Effect.flatMap(({ result }) => Schema.encodeEffect(FinalOrderTaxResponseSchema)(result)),
        Effect.flatMap(Schema.decodeUnknownEffect(FinalOrderTaxResponseSchema)),
      );

      // The #330 Bundle content is exactly the public handoff: final at T, submission, unverified foreign evidence.
      const handoff = yield* Schema.encodeEffect(FinalOrderTaxHandoffSchema)(recovered.handoff).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(FinalOrderTaxHandoffSchema)),
      );
      expect(handoff.submissionRef).toBe(submission);
      expect(DateTime.formatIso(handoff.orderCommitmentTime)).toBe(T);
      expect(handoff.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(handoff.outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
    }),
  ),
);
