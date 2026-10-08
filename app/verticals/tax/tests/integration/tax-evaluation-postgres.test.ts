import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
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
  CreateTaxRulePayloadSchema,
  EstablishTaxFactAuthorityContractPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../../src/database/schema.ts';
import { CustomerSafeTaxNotDeterminedSchema } from '../../src/domain/customer-safe-tax-projection.ts';
import {
  TaxDependencyUnavailableSchema,
  TaxInputStaleSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { taxAuthorityGovernancePersistenceForScope } from '../../src/services/tax-authority-governance.service.ts';
import { taxEvaluationForScope } from '../../src/services/tax-evaluation.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { taxSourceAssertionPersistenceForScope } from '../../src/services/tax-source-assertion.service.ts';
import { catalogEntry, evaluationRequestInput, decodeEvaluationRequest } from '../unit/tax-evaluation-fixtures.ts';
import { purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';

const tenantId = randomUUID();
const principalId = randomUUID();
const FACT_FAMILY = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION';

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
const invocation = (scope: OperationalScope) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxEvaluationRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
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
  const establishAuthority = Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
    authority: { authorityFrom: '2026-01-01T00:00:00.000Z', evidenceSourceRefs: [], systemOfRecordRef: 'erp.finance' },
    factFamily: FACT_FAMILY,
    provenanceRef: 'acceptance:authority',
    reason: 'Govern VAT registration authority',
    stableCode: 'cz.vat-registration',
  }).pipe(
    Effect.flatMap((payload) =>
      runScoped(runtime, scope, (transaction) =>
        taxAuthorityGovernancePersistenceForScope(transaction, scope).establishContract({
          ...payload,
          ...invocation(scope),
        }),
      ),
    ),
  );
  const recordRegistration = (validity: Readonly<{ validTo?: string }> = {}) =>
    Schema.decodeEffect(RecordTaxSourceAssertionPayloadSchema)({
      factFamily: FACT_FAMILY,
      jurisdiction: 'CZ_DOMESTIC',
      provenanceRef: 'acceptance:registration',
      reason: 'Record seller VAT registration evidence',
      registrationMeaning: 'REGISTERED',
      sourceAssertionKey: `erp-assertion-${randomUUID()}`,
      sourceRecordRef: 'erp-record-1',
      sourceRef: 'erp.finance',
      validFrom: '2026-01-01T00:00:00.000Z',
      ...validity,
    }).pipe(
      Effect.flatMap((payload) =>
        runScoped(runtime, scope, (transaction) =>
          taxSourceAssertionPersistenceForScope(transaction, scope).recordAssertion({
            ...payload,
            ...invocation(scope),
          }),
        ),
      ),
    );
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
  return { createRule, establishAuthority, evaluate, launchRules, legalEntityId, recordRegistration };
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
const decisionIdOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const outcome = outcomeOf(response);
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome.decision.decisionId;
};

it.live('#942 #936 #941 prospective evaluation over complete TAX own state publishes one Decision and Result', () =>
  Effect.scoped(
    Effect.gen(function* prospectiveEvaluationAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.establishAuthority;
      yield* subject.recordRegistration();
      yield* subject.launchRules;

      const response = yield* subject.evaluate();
      const evaluated = evaluatedOf(response);
      const { outcome } = evaluated;

      expect(isSuccess(outcome) && outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(evaluated.customerSafe).toMatchObject({ purchaseTaxTotal: { amount: '270.00', currency: 'CZK' } });
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(evaluated.evidence.attempts).toBe(1);
      expect(evaluated.evidence.sellerRegistration.state).toBe('CURRENT_POSITIVE');
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

it.live('#942 F12-F15 #938 complete rule state and seller state keep their own typed non-success meanings', () =>
  Effect.scoped(
    Effect.gen(function* nonSuccessAcceptance() {
      const { runtime } = yield* acquireDatabases;

      const noAuthority = seller(runtime);
      yield* noAuthority.launchRules;
      // No governed System of Record: the seller state cannot be concluded.
      expect(outcomeOf(yield* noAuthority.evaluate())).toEqual(TaxStateIndeterminateSchema.make({}));

      const elapsed = seller(runtime);
      yield* elapsed.establishAuthority;
      yield* elapsed.recordRegistration({ validTo: '2026-03-01T00:00:00.000Z' });
      yield* elapsed.launchRules;
      // The only positive evidence ended before Tax Evaluation Time (#942 F7).
      expect(outcomeOf(yield* elapsed.evaluate())).toEqual(TaxInputStaleSchema.make({}));

      const missing = seller(runtime);
      yield* missing.establishAuthority;
      yield* missing.recordRegistration();
      yield* missing.createRule('cz.standard', 'cz-standard-goods', '21');
      // The reduced code has a complete, authoritative and empty applicable set.
      expect(outcomeOf(yield* missing.evaluate())).toEqual(TaxRuleMissingSchema.make({}));

      const overlapping = seller(runtime);
      yield* overlapping.establishAuthority;
      yield* overlapping.recordRegistration();
      yield* overlapping.launchRules;
      yield* overlapping.createRule('cz.standard-duplicate', 'cz-standard-goods', '21');
      expect(outcomeOf(yield* overlapping.evaluate())).toEqual(TaxRuleOverlapSchema.make({}));

      const placeUnavailable = seller(runtime);
      yield* placeUnavailable.establishAuthority;
      yield* placeUnavailable.recordRegistration();
      yield* placeUnavailable.launchRules;
      const response = yield* placeUnavailable.evaluate({
        places: {
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
          invoiceRecipient: { _tag: 'NOT_MATERIAL' },
          sellingLegalEntity: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef: 'seller-place' },
        },
      });
      expect(outcomeOf(response)).toEqual(TaxDependencyUnavailableSchema.make({}));
      expect(evaluatedOf(response).customerSafe).toEqual(
        CustomerSafeTaxNotDeterminedSchema.make({ contractVersion: 1 }),
      );
    }),
  ),
);

it.live('#950 F24 #942 F22 the trusted scope and a future Tax-Relevant Time bound every evaluation', () =>
  Effect.scoped(
    Effect.gen(function* scopeAndTimeAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const subject = seller(runtime);
      yield* subject.establishAuthority;
      yield* subject.recordRegistration();
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
