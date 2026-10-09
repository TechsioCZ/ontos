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
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import {
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { CustomerSafeSellerNotVatPayerSchema } from '../../src/domain/customer-safe-tax-projection.ts';
import {
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { taxEvaluationForScope } from '../../src/services/tax-evaluation.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { catalogEntry, evaluationRequestInput, decodeEvaluationRequest } from '../unit/tax-evaluation-fixtures.ts';
import { purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';

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
  const launchRules = Effect.all([
    createRule('cz.standard', 'cz-standard-goods', '21'),
    createRule('cz.reduced', 'cz-reduced-food', '12'),
  ]);
  return { createRule, declare, declareNonPayer, declareVatPayer, evaluate, launchRules, legalEntityId, scope };
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
