import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { CreateTaxRulePayloadSchema } from '../../shared/actions/tax-governance.ts';
import { DeclareSellerVatRegimePayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import type { DeclareSellerVatRegimePayload } from '../../shared/actions/seller-vat-regime-declaration.ts';
import { TaxEvaluationRequestSchema, TaxEvaluationResponseSchema } from '../../shared/apis/tax-evaluation.ts';
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import { readTaxEvaluation } from '../../src/api/tax-evaluation.read.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import {
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { LineCommercialValueBasisSchema } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import { CustomerSafeSellerNotVatPayerSchema } from '../../src/domain/customer-safe-tax-projection.ts';
import {
  TaxCaseUnsupportedSchema,
  TaxDependencyUnavailableSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { taxEvaluationForScope } from '../../src/services/tax-evaluation.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import {
  PRICING_RESULT_REF,
  STANDARD_CODE,
  catalogEntry,
  decodeEvaluationRequest,
  evaluationRequestInput,
  grossLine,
  pricingLine,
  shippingCharge,
} from '../unit/tax-evaluation-fixtures.ts';
import { occurrenceInput, purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';

const tenantId = randomUUID();
const principalId = randomUUID();

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

/** Fixed trusted operation time for governed setup; evaluation itself uses the real server clock. */
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope, at = operationTime) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxEvaluationRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenantId));
      yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenantId));
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireTaxEvaluationTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { runtime };
});

/** Governed TAX setup of one seller, through the same owner services the Actions use. */
const seller = (runtime: CoreTestDatabase) => {
  const legalEntityId = randomUUID();
  const scope = scopeFor(legalEntityId);
  const declare = (overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {}) =>
    Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared backdated effect for acceptance fixtures',
      regime: 'VAT_PAYER',
      ...overrides,
    }).pipe(
      Effect.flatMap((payload: DeclareSellerVatRegimePayload) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
            ...payload,
            ...invocation(scope),
          }),
        ),
      ),
    );
  const declareVatPayer = () => declare({ regime: 'VAT_PAYER' });
  const declareNonPayer = () => declare({ reason: 'Merchant-declared non-payer', regime: 'NON_PAYER' });
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
    );
  const evaluate = (overrides: Parameters<typeof evaluationRequestInput>[0] = {}) =>
    runScoped(runtime, scope, (transaction) =>
      taxEvaluationForScope(transaction, scope).evaluate(
        decodeEvaluationRequest(
          evaluationRequestInput({
            purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
            taxRelevantTime: '2026-06-01T00:00:00.000Z',
            ...overrides,
          }),
        ),
      ),
    );
  /**
   * #961 F1 H1: the public read handler over persisted TAX state. The wire request decodes through the public
   * `TaxEvaluationRequestSchema`, and the response round-trips through the public `TaxEvaluationResponseSchema`.
   */
  const readPublic = (overrides: Parameters<typeof evaluationRequestInput>[0] = {}) =>
    Schema.decodeEffect(TaxEvaluationRequestSchema)(
      evaluationRequestInput({
        purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
        taxRelevantTime: '2026-06-01T00:00:00.000Z',
        ...overrides,
      }),
    ).pipe(
      Effect.flatMap((request) =>
        runScoped(runtime, scope, (transaction) =>
          readTaxEvaluation(request, {
            readKey: 'commerce.tax.api.tax-evaluation',
            scope,
            services: { evaluations: taxEvaluationForScope(transaction, scope) },
          }),
        ),
      ),
      Effect.flatMap(({ result }) => Schema.encodeEffect(TaxEvaluationResponseSchema)(result)),
      Effect.flatMap(Schema.decodeUnknownEffect(TaxEvaluationResponseSchema)),
      Effect.asSome,
    );
  const launchRules = Effect.all([
    createRule('cz.standard', 'cz-standard-goods', '21'),
    createRule('cz.reduced', 'cz-reduced-food', '12'),
  ]);
  return {
    createRule,
    declare,
    declareNonPayer,
    declareVatPayer,
    evaluate,
    launchRules,
    legalEntityId,
    readPublic,
    scope,
  };
};

const EvaluatedSchema = Schema.TaggedStruct('EVALUATED', {});
const isEvaluated = Schema.is(EvaluatedSchema);
const isRejected = Schema.is(
  Schema.TaggedStruct('TAX_EVALUATION_REQUEST_REJECTED', { reasons: Schema.Array(Schema.String) }),
);
const isSuccess = Schema.is(TaxOutcomeSuccessSchema);

const evaluatedOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const value = Option.getOrThrow(response);
  if (!isEvaluated(value)) {
    throw new Error('Expected an evaluated response');
  }
  return value;
};
const outcomeOf = (response: Option.Option<TaxEvaluationResponse>): TaxOutcome => evaluatedOf(response).outcome;
/** The declared regime of one evidence selection; throws on `NOT_DECLARED`, which every caller here excludes. */
const declaredRegimeOf = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime),
    Match.tag('NOT_DECLARED', () => {
      throw new Error('Expected a DECLARED Seller VAT Regime selection');
    }),
    Match.exhaustive,
  );

const decisionIdOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const outcome = outcomeOf(response);
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome.decision.decisionId;
};

it.live('#942 #936 #941 a VAT_PAYER seller publishes one rated Decision and Result from complete rule state', () =>
  Effect.scoped(
    Effect.gen(function* prospectiveEvaluationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.evaluate();
      const evaluated = evaluatedOf(response);
      const { outcome } = evaluated;

      expect(isSuccess(outcome) && outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(evaluated.customerSafe).toMatchObject({ purchaseTaxTotal: { amount: '270.00', currency: 'CZK' } });
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(evaluated.evidence.attempts).toBe(1);
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(
        evaluated.evidence.ruleSets.map(({ outcome: ruleSetOutcome, rowCount, taxClassificationCode }) => [
          taxClassificationCode,
          ruleSetOutcome,
          rowCount,
        ]),
      ).toEqual([
        ['cz-reduced-food', 'SELECTED', 1],
        ['cz-standard-goods', 'SELECTED', 1],
      ]);
      // Tax Evaluation Time is trusted server time, never the caller's Tax-Relevant Time (#941 F1, F3).
      expect(DateTime.isGreaterThan(evaluated.evidence.taxEvaluationTime, evaluated.evidence.taxRelevantTime)).toBe(
        true,
      );
      // #942 F23 the same complete state and input give the same Decision identity.
      expect(decisionIdOf(yield* subject.evaluate())).toBe(decisionIdOf(response));
    }),
  ),
);

it.live(
  'Unit 10 C a NON_PAYER seller publishes a zero-tax Decision with no rule read and the non-payer projection',
  () =>
    Effect.scoped(
      Effect.gen(function* nonPayerAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        yield* subject.declareNonPayer();
        // No Tax Rules exist at all; a NON_PAYER seller makes no rule read and still succeeds (#942 F5, F9-F21).

        const response = yield* subject.evaluate();
        const evaluated = evaluatedOf(response);
        const { outcome } = evaluated;

        expect(isSuccess(outcome) && outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
        expect(evaluated.evidence.ruleSets).toEqual([]);
        expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('NON_PAYER');
        expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluated.customerSafe)).toBe(true);
      }),
    ),
);

it.live('Unit 10 C a seller with nothing declared is indeterminate, never a stored final meaning', () =>
  Effect.scoped(
    Effect.gen(function* notDeclaredAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.launchRules;

      const response = yield* subject.evaluate();
      expect(outcomeOf(response)).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(evaluatedOf(response).evidence.notDeterminedBecause).toBe('SELLER_VAT_REGIME_NOT_DECLARED');
    }),
  ),
);

it.live('#942 F12-F15 #938 a VAT_PAYER seller with incomplete or conflicting rule state keeps its typed meaning', () =>
  Effect.scoped(
    Effect.gen(function* nonSuccessAcceptance() {
      const { runtime } = yield* acquireDatabases;

      const missing = seller(runtime);
      yield* missing.declareVatPayer();
      yield* missing.createRule('cz.standard', 'cz-standard-goods', '21');
      // The reduced code has a complete, authoritative and empty applicable set.
      expect(outcomeOf(yield* missing.evaluate())).toEqual(TaxRuleMissingSchema.make({}));

      const overlapping = seller(runtime);
      yield* overlapping.declareVatPayer();
      yield* overlapping.launchRules;
      yield* overlapping.createRule('cz.standard-duplicate', 'cz-standard-goods', '21');
      expect(outcomeOf(yield* overlapping.evaluate())).toEqual(TaxRuleOverlapSchema.make({}));
    }),
  ),
);

it.live('Unit 10 C a regime revision effective after T but recorded before E still selects the regime at T', () =>
  Effect.scoped(
    Effect.gen(function* regimeAtTAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // T is in June; a NON_PAYER revision becomes effective in August, recorded now (well before E).
      yield* subject.declare({
        confirmReplacesScheduled: true,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        expectedCurrentRevision: 1,
        regime: 'NON_PAYER',
      });

      const response = yield* subject.evaluate({ taxRelevantTime: '2026-06-01T00:00:00.000Z' });
      const evaluated = evaluatedOf(response);
      expect(isSuccess(evaluated.outcome) && evaluated.outcome.result.purchaseTaxTotal).toEqual({
        amount: '270.00',
        currency: 'CZK',
      });
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(evaluated.evidence.sellerVatRegime.headRevision).toBe(2);
    }),
  ),
);

it.live('#950 F24 #942 F22 the trusted scope and a future Tax-Relevant Time bound every evaluation', () =>
  Effect.scoped(
    Effect.gen(function* scopeAndTimeAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // A purchase naming another Selling Legal Entity is not visible in this scope.
      const foreign = yield* subject.evaluate({
        purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: randomUUID(), tenantId }),
      });
      expect(Option.isNone(foreign)).toBe(true);
      // A purchase naming another Tenant is not visible either, whatever its seller (#950 F24).
      const otherTenant = yield* subject.evaluate({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: randomUUID(),
        }),
      });
      expect(Option.isNone(otherTenant)).toBe(true);

      const future = Option.getOrThrow(yield* subject.evaluate({ taxRelevantTime: '2099-01-01T00:00:00.000Z' }));
      expect(isRejected(future) && future.reasons).toEqual(['FUTURE_TAX_RELEVANT_TIME']);

      const unbound = Option.getOrThrow(
        yield* subject.evaluate({ catalog: [catalogEntry('o1', 'cz-standard-goods')] }),
      );
      expect(isRejected(unbound) && unbound.reasons).toEqual(['STRUCTURAL_BINDING_INVALID']);
    }),
  ),
);

it.live(
  'PO decision D3 on #907: a GROSS Shipping allocation round-trips through the stored Decision and jsonb Result',
  () =>
    Effect.scoped(
      Effect.gen(function* shippingAllocationAcceptance() {
        const { runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        yield* subject.declareVatPayer();
        yield* subject.launchRules;

        const shippingRequest = {
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
        } as const;

        const response = yield* subject.evaluate(shippingRequest);
        const outcome = outcomeOf(response);
        if (!isSuccess(outcome)) {
          throw new Error('Expected a successful Tax Outcome');
        }
        expect(outcome.result.purchaseTaxTotal.amount).toBe('47.02');
        // The exact gross-weighted shares (99 * 121/233, 99 * 112/233) and the code-versioned allocation key
        // round-trip through the jsonb Decision store, not just the rounded published amounts (#907 plan §5.4).
        expect(
          outcome.decision.shippingAllocation?.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
            taxableSupplyUnitId,
            basisComponent.amount,
            basisComponent.amountBasis,
            basisComponent.allocationKey,
          ]),
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

        // Same-submission recovery (#942 F23): the identical input and state give back the same Decision identity
        // and the identical Shipping allocation and Result, read back through the jsonb store.
        const replay = yield* subject.evaluate(shippingRequest);
        const replayOutcome = outcomeOf(replay);
        if (!isSuccess(replayOutcome)) {
          throw new Error('Expected a successful Tax Outcome');
        }
        expect(replayOutcome.decision.decisionId).toBe(outcome.decision.decisionId);
        expect(replayOutcome.decision.shippingAllocation).toEqual(outcome.decision.shippingAllocation);
        expect(replayOutcome.result.purchaseTaxTotal).toEqual(outcome.result.purchaseTaxTotal);
      }),
    ),
);

const CreatedRuleIdSchema = Schema.Struct({ taxRuleId: Schema.String.pipe(Schema.brand('TaxTestRuleId')) });
const successOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const outcome = outcomeOf(response);
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome;
};
const publishedByUnit = (response: Option.Option<TaxEvaluationResponse>) =>
  successOf(response).result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
    taxableSupplyUnitId,
    publishedTaxAmount.amount,
  ]);
const centsOf = (amount: string) => BigInt(amount.replace('.', ''));

it.live('#961 scenario 1: ordinary B2C for a declared VAT_PAYER seller through the public read handler', () =>
  Effect.scoped(
    Effect.gen(function* ordinaryB2cScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      const ruleIds = (yield* Schema.decodeUnknownEffect(Schema.Array(CreatedRuleIdSchema))(yield* subject.launchRules))
        .map(({ taxRuleId }) => taxRuleId)
        .toSorted();

      const response = yield* subject.readPublic();
      const evaluated = evaluatedOf(response);
      const outcome = successOf(response);

      // One Taxable Supply Unit per purchase occurrence, each rounded separately.
      expect(publishedByUnit(response)).toEqual([
        ['taxable-supply-unit:o1', '210.00'],
        ['taxable-supply-unit:o2', '60.00'],
      ]);
      // The total is the exact sum of the published unit amounts.
      const unitSum = outcome.result.units.reduce(
        (sum, { publishedTaxAmount }) => sum + centsOf(publishedTaxAmount.amount),
        0n,
      );
      expect(centsOf(outcome.result.purchaseTaxTotal.amount)).toBe(unitSum);
      // The evidence names the governing persisted Tax Rule revisions and the declared Seller VAT Regime revision.
      expect(
        outcome.decision.units
          .map((unit) => ('governingTaxRuleRevisionRef' in unit ? unit.governingTaxRuleRevisionRef : undefined))
          .map((ref) => `${ref?.taxRuleId}@${ref?.revision}`)
          .toSorted(),
      ).toEqual(ruleIds.map((taxRuleId) => `${taxRuleId}@1`).toSorted());
      expect(outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(outcome.decision.declarationRevisionRef.revision).toBe(1);
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
    }),
  ),
);

it.live('#961 scenario 2: ordinary B2B with no buyer VAT status has the same success meaning as B2C', () =>
  Effect.scoped(
    Effect.gen(function* ordinaryB2bScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const b2c = yield* subject.readPublic();
      const b2b = yield* subject.readPublic({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: 'counterparty-1' },
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId,
          traceabilityContext: { channel: 'B2B', storefrontRef: 'storefront-1' },
        }),
      });

      expect(publishedByUnit(b2b)).toEqual(publishedByUnit(b2c));
      expect(successOf(b2b).result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(evaluatedOf(b2b).evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
    }),
  ),
);

it.live('#961 scenario 3: two equal-valued distinct occurrences at 21 % stay two units, each rounded separately', () =>
  Effect.scoped(
    Effect.gen(function* equalOccurrencesScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.readPublic({
        catalog: [catalogEntry('o1', STANDARD_CODE), catalogEntry('o2', STANDARD_CODE)],
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [pricingLine('o1', '0.03'), pricingLine('o2', '0.03')],
        },
      });

      // 0.03 * 21 % = 0.0063 per unit rounds to 0.01 each; a merged 0.06 base would publish 0.01 in total.
      expect(publishedByUnit(response)).toEqual([
        ['taxable-supply-unit:o1', '0.01'],
        ['taxable-supply-unit:o2', '0.01'],
      ]);
      expect(successOf(response).result.purchaseTaxTotal).toEqual({ amount: '0.02', currency: 'CZK' });
    }),
  ),
);

it.live('#961 scenario 4: a supported whole-treatment Set is one Taxable Supply Unit with no component prices', () =>
  Effect.scoped(
    Effect.gen(function* wholeTreatmentSetScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const setSelection = {
        productRef: 'product-1',
        setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-1' },
        variantRef: 'variant-1',
      };
      const response = yield* subject.readPublic({
        catalog: [catalogEntry('o1', STANDARD_CODE, { catalogSelection: setSelection })],
        pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '1000.00')] },
        purchase: purchaseBindingInput(['o1'], {
          purchaseDemandOccurrences: [{ ...occurrenceInput('o1'), catalogSelection: setSelection }],
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId,
        }),
        setSupplyMeanings: [{ meaning: 'WHOLE_TREATMENT_SET', occurrenceId: 'o1' }],
      });

      const outcome = successOf(response);
      expect(publishedByUnit(response)).toEqual([['taxable-supply-unit:o1', '210.00']]);
      const [unit] = outcome.decision.units;
      expect(
        Match.value(unit.taxableSupplyUnit.mapping).pipe(
          Match.tag('WHOLE_TREATMENT_SET', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      // The Set's own published line is the only basis component: no component prices enter the unit.
      expect(unit.taxableBasisInterpretation.components).toHaveLength(1);
      expect(Schema.is(LineCommercialValueBasisSchema)(unit.taxableBasisInterpretation.components[0])).toBe(true);
    }),
  ),
);

it.live('#961 scenario 5: a complete empty rule state for a supported case is TAX_RULE_MISSING, never 0 CZK', () =>
  Effect.scoped(
    Effect.gen(function* completeEmptyScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();

      const response = yield* subject.readPublic();
      expect(outcomeOf(response)).toEqual(TaxRuleMissingSchema.make({}));
      expect(evaluatedOf(response).evidence.ruleSets.map(({ outcome, rowCount }) => [outcome, rowCount])).toEqual([
        ['TAX_RULE_MISSING', 0],
        ['TAX_RULE_MISSING', 0],
      ]);
    }),
  ),
);

it.live('#961 scenario 6: an unavailable delivery destination is TAX_DEPENDENCY_UNAVAILABLE, never a CZ fallback', () =>
  Effect.scoped(
    Effect.gen(function* unavailableSourceScenario() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.readPublic({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        },
      });
      expect(outcomeOf(response)).toEqual(TaxDependencyUnavailableSchema.make({}));
    }),
  ),
);

it.live(
  '#961 scenario 7: a known non-CZ destination with rules present is TAX_CASE_UNSUPPORTED, no domestic fallback',
  () =>
    Effect.scoped(
      Effect.gen(function* nonCzechDestinationScenario() {
        const { runtime } = yield* acquireDatabases;
        const subject = seller(runtime);
        yield* subject.declareVatPayer();
        yield* subject.launchRules;

        const response = yield* subject.readPublic({
          places: {
            ...evaluationRequestInput().places,
            deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'DE', ownerEvidenceRef: 'delivery-de' },
          },
        });
        expect(outcomeOf(response)).toEqual(
          TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' }),
        );
      }),
    ),
);

it.live('#961 scenario 8: a NON_PAYER seller succeeds as non-payer and an undeclared seller is indeterminate', () =>
  Effect.scoped(
    Effect.gen(function* sellerRegimeScenario() {
      const { runtime } = yield* acquireDatabases;
      const nonPayer = seller(runtime);
      yield* nonPayer.declareNonPayer();
      const undeclared = seller(runtime);
      yield* undeclared.launchRules;

      const nonPayerResponse = yield* nonPayer.readPublic();
      expect(successOf(nonPayerResponse).decision.sellerVatRegime).toBe('NON_PAYER');
      expect(successOf(nonPayerResponse).result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
      expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluatedOf(nonPayerResponse).customerSafe)).toBe(true);

      const undeclaredResponse = yield* undeclared.readPublic();
      expect(outcomeOf(undeclaredResponse)).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(evaluatedOf(undeclaredResponse).evidence.notDeterminedBecause).toBe('SELLER_VAT_REGIME_NOT_DECLARED');
    }),
  ),
);
