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
import { FinalizeOrderTaxPayloadSchema } from '../../shared/actions/order-tax-finalization.ts';
import { DeclareSellerVatRegimePayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import { CreateTaxRulePayloadSchema } from '../../shared/actions/tax-governance.ts';
import { TaxPrivacyOwnerCoverageRequestSchema } from '../../shared/apis/tax-privacy-owner-coverage.ts';
import type {
  TaxPrivacyOwnerCoverageResponse,
  TaxPrivacyOwnerLookupSchema,
} from '../../shared/apis/tax-privacy-owner-coverage.ts';
import { taxPrivacyOwnerScopeRef, taxPrivacyOwnerScopeRefs } from '../../shared/tax-privacy-owner-contract.ts';
import {
  taxOrderTaxFinalizations,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { orderTaxFinalizationsForScope } from '../../src/services/order-tax-finalization.service.ts';
import { taxPrivacyCoverageForScope } from '../../src/services/tax-privacy-coverage.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import { evaluationRequestInput } from '../unit/tax-evaluation-fixtures.ts';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const sellerA = randomUUID();
const sellerB = randomUUID();
const principalId = randomUUID();
const otherPrincipalId = randomUUID();
const byText = (left: string, right: string) => left.localeCompare(right, 'en');

type TaxPrivacyOwnerLookupEncoded = typeof TaxPrivacyOwnerLookupSchema.Encoded;

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
const invocation = (scope: OperationalScope) => ({
  actionInvocationId: randomUUID(),
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime,
  tenantId: scope.tenantId,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxPrivacyRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      for (const tenant of [tenantId, otherTenantId]) {
        yield* transaction
          .delete(taxSellerVatRegimeDeclarations)
          .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenant));
        yield* transaction.delete(taxOrderTaxFinalizations).where(eq(taxOrderTaxFinalizations.tenantId, tenant));
        yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenant));
        yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenant));
        yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenant));
        yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenant));
      }
    }),
  );

/** Seller A holds one Seller VAT Regime Declaration revision, attributed to `principalId`. */
const acquireSeededDatabase = Effect.gen(function* acquireTaxPrivacyTestDatabase() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  const declaration = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    expectedCurrentRevision: 0,
    reason: 'Merchant-declared Czech VAT payer',
    regime: 'VAT_PAYER',
  });
  yield* runScoped(runtime, scopeA, (transaction) =>
    sellerVatRegimeDeclarationsForScope(transaction, scopeA).declare({
      ...declaration,
      ...invocation(scopeA),
    }),
  );
  return runtime;
});

const coverageOf = (
  runtime: CoreTestDatabase,
  scope: OperationalScope,
  lookups: readonly TaxPrivacyOwnerLookupEncoded[],
  tenant: string = scope.tenantId,
) =>
  Schema.decodeEffect(TaxPrivacyOwnerCoverageRequestSchema)({
    scope: {
      controllerRef: 'legal-entity:controller',
      ownerCapability: 'commerce.tax',
      requestedScopePartRefs: [...taxPrivacyOwnerScopeRefs],
      requestedScopeRef: 'privacy-owner-scope:tax/integration',
      subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:subject' },
      tenantId: tenant,
      trustedLookupRefs: lookups.map(({ lookupRef }) => lookupRef),
    },
    trustedLookups: lookups,
  }).pipe(
    Effect.flatMap((request) =>
      runScoped(runtime, scope, (transaction) => taxPrivacyCoverageForScope(transaction, scope).coverage(request)),
    ),
  );

const seller = (legalEntityId: string): TaxPrivacyOwnerLookupEncoded => ({
  _tag: 'SELLING_LEGAL_ENTITY',
  legalEntityId,
  lookupRef: `seller:${legalEntityId}`,
});
const principal = (id: string): TaxPrivacyOwnerLookupEncoded => ({
  _tag: 'ACTOR_PRINCIPAL',
  lookupRef: `principal:${id}`,
  principalId: id,
});

/** Content kinds found for one responsibility; refs are `commerce.tax.<kind>:<record id>`. */
const foundIn = (
  result: Option.Option<TaxPrivacyOwnerCoverageResponse>,
  scopePart: Parameters<typeof taxPrivacyOwnerScopeRef>[0],
) =>
  Option.getOrThrow(result)
    .coverage.coverageParts.filter(({ scopeRef }) => scopeRef === taxPrivacyOwnerScopeRef(scopePart))
    .flatMap(({ foundContentRefs }) => foundContentRefs)
    .map((ref) => ref.slice('commerce.tax.'.length).split(':')[0] ?? '');

it.live('#956 F19 a seller with no TAX content is complete NO_DATA over every TAX responsibility', () =>
  Effect.scoped(
    Effect.gen(function* emptySellerCoverage() {
      const runtime = yield* acquireSeededDatabase;
      const result = Option.getOrThrow(yield* coverageOf(runtime, scopeB, [seller(sellerB)]));
      expect(result.coverage.coverageStatus).toBe('COMPLETE');
      expect(result.coverage.contentStatus).toBe('NO_DATA');
      expect(result.coverage.coverageParts.map(({ scopeRef }) => scopeRef)).toEqual(taxPrivacyOwnerScopeRefs);
      expect(result.ownerDeclaration.acceptedTaxTermsCopyHolders.length).toBeGreaterThan(0);
    }),
  ),
);

it.live('#956 F13-F16 a sole-trader seller finds exact TAX content per responsibility, not copied profiles', () =>
  Effect.scoped(
    Effect.gen(function* sellerCoverage() {
      const runtime = yield* acquireSeededDatabase;
      const result = yield* coverageOf(runtime, scopeA, [seller(sellerA)]);
      expect(Option.getOrThrow(result).coverage.contentStatus).toBe('FOUND');
      expect(foundIn(result, 'SELLER_VAT_REGIME_DECLARATION_HISTORY')).toEqual(['seller-vat-regime-declaration']);
      expect(foundIn(result, 'ACCEPTED_TAX_TERMS_COPIES')).toEqual([]);
      expect(foundIn(result, 'ACTOR_PRINCIPAL_ATTRIBUTION')).toEqual([]);
      // Minimization (#907 D2 default, ADR-0027): no Launch Order Tax finalization was recorded for this seller.
      expect(foundIn(result, 'ORDER_TAX_FINALIZATION_DECISION_EVIDENCE')).toEqual([]);
    }),
  ),
);

it.live('#956 F19-F25 a staff principal finds only attributing TAX rows and never seller-local NO_DATA', () =>
  Effect.scoped(
    Effect.gen(function* principalCoverage() {
      const runtime = yield* acquireSeededDatabase;
      const attributed = yield* coverageOf(runtime, scopeA, [principal(principalId)]);
      const attribution = Option.getOrThrow(attributed).coverage.coverageParts.find(
        ({ scopeRef }) => scopeRef === taxPrivacyOwnerScopeRef('ACTOR_PRINCIPAL_ATTRIBUTION'),
      );
      expect(attribution?.coverageStatus).toBe('PARTIAL');
      expect(attribution?.evidenceRefs.every((ref) => ref.includes(`/${sellerA}/`))).toBe(true);
      expect(foundIn(attributed, 'ACTOR_PRINCIPAL_ATTRIBUTION').toSorted(byText)).toEqual([
        'seller-vat-regime-declaration',
      ]);
      expect(foundIn(attributed, 'SELLER_VAT_REGIME_DECLARATION_HISTORY')).toEqual([]);
      // The same principal under seller B: rows under seller A are invisible, so coverage stays unresolved.
      const otherSeller = Option.getOrThrow(yield* coverageOf(runtime, scopeB, [principal(principalId)]));
      expect(otherSeller.coverage.coverageStatus).toBe('PARTIAL');
      expect(otherSeller.coverage.contentStatus).toBe('UNKNOWN');
      const other = Option.getOrThrow(yield* coverageOf(runtime, scopeA, [principal(otherPrincipalId)]));
      expect(other.coverage.contentStatus).toBe('UNKNOWN');
    }),
  ),
);

it.live('#956 F27 #950 F24-F28 coverage never reaches another seller or Tenant', () =>
  Effect.scoped(
    Effect.gen(function* foreignCoverage() {
      const runtime = yield* acquireSeededDatabase;
      expect(Option.isNone(yield* coverageOf(runtime, scopeB, [seller(sellerA)]))).toBe(true);
      expect(Option.isNone(yield* coverageOf(runtime, scopeA, [seller(sellerA)], otherTenantId))).toBe(true);
      const otherTenant = scopeFor(otherTenantId, sellerA);
      const isolated = Option.getOrThrow(yield* coverageOf(runtime, otherTenant, [seller(sellerA)]));
      expect(isolated.coverage.contentStatus).toBe('NO_DATA');
    }),
  ),
);

/** Creates one launched TAX rule so a finalization candidate's classification can resolve against it. */
const createLaunchRule = (
  runtime: CoreTestDatabase,
  scope: OperationalScope,
  stableCode: string,
  taxClassificationCode: string,
  ratePercent: string,
) =>
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
    provenanceRef: `acceptance:privacy-finalization:${stableCode}`,
    reason: 'Czech VAT rate for privacy coverage finalization fixture',
    stableCode,
  }).pipe(
    Effect.flatMap((payload) =>
      runScoped(runtime, scope, (transaction) =>
        taxRuleGovernancePersistenceForScope(transaction, scope).createTaxRule({ ...payload, ...invocation(scope) }),
      ),
    ),
  );

/** Finalizes one Order Tax for seller A so the owner coverage lookup has a real finalization row. */
const finalizeOrderForSellerA = (runtime: CoreTestDatabase) =>
  Effect.gen(function* finalizeOrderTaxForPrivacyCoverage() {
    // Both occurrence classification codes used by the default evaluation fixture need a launched rule.
    yield* createLaunchRule(runtime, scopeA, 'cz.standard.privacy-finalization', 'cz-standard-goods', '21');
    yield* createLaunchRule(runtime, scopeA, 'cz.reduced.privacy-finalization', 'cz-reduced-food', '12');
    const { taxRelevantTime: _taxRelevantTime, ...candidate } = evaluationRequestInput({
      purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: sellerA, tenantId }),
    });
    const payload = yield* Schema.decodeEffect(FinalizeOrderTaxPayloadSchema)({
      candidate,
      orderCommitmentTime: '2026-06-01T10:00:00.000Z',
      provenanceRef: 'acceptance:privacy-finalization',
      reason: 'Final Order Tax at Order Commitment Time',
      submissionRef: `submission-privacy-${randomUUID()}`,
    });
    return yield* runScoped(runtime, scopeA, (transaction) =>
      orderTaxFinalizationsForScope(transaction, scopeA).finalize({ ...payload, ...invocation(scopeA) }),
    );
  });

it.live('#956 F13-F16 a seller with a finalized Order Tax finds its own finalization evidence', () =>
  Effect.scoped(
    Effect.gen(function* finalizedSellerCoverage() {
      const runtime = yield* acquireSeededDatabase;
      const outcome = yield* finalizeOrderForSellerA(runtime);
      if ('kind' in outcome) {
        throw new Error(`Expected a finalization result, got ${outcome.kind}`);
      }
      const result = yield* coverageOf(runtime, scopeA, [seller(sellerA)]);
      expect(Option.getOrThrow(result).coverage.contentStatus).toBe('FOUND');
      expect(foundIn(result, 'ORDER_TAX_FINALIZATION_DECISION_EVIDENCE')).toEqual(['order-tax-finalization']);
    }),
  ),
);
