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
import { EstablishTaxFactAuthorityContractPayloadSchema } from '../../shared/actions/tax-governance.ts';
import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import { TaxPrivacyOwnerCoverageRequestSchema } from '../../shared/apis/tax-privacy-owner-coverage.ts';
import type {
  TaxPrivacyOwnerCoverageResponse,
  TaxPrivacyOwnerLookupSchema,
} from '../../shared/apis/tax-privacy-owner-coverage.ts';
import { taxPrivacyOwnerScopeRef, taxPrivacyOwnerScopeRefs } from '../../shared/tax-privacy-owner-contract.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxOrderTaxFinalizations,
  taxRelations,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../../src/database/schema.ts';
import { taxAuthorityGovernancePersistenceForScope } from '../../src/services/tax-authority-governance.service.ts';
import { taxPrivacyCoverageForScope } from '../../src/services/tax-privacy-coverage.service.ts';
import { taxSourceAssertionPersistenceForScope } from '../../src/services/tax-source-assertion.service.ts';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const sellerA = randomUUID();
const sellerB = randomUUID();
const principalId = randomUUID();
const otherPrincipalId = randomUUID();
const FACT_FAMILY = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION';
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
        yield* transaction.delete(taxSourceConflicts).where(eq(taxSourceConflicts.tenantId, tenant));
        yield* transaction.delete(taxSourceAssertions).where(eq(taxSourceAssertions.tenantId, tenant));
        yield* transaction
          .delete(taxFactAuthorityContractRevisions)
          .where(eq(taxFactAuthorityContractRevisions.tenantId, tenant));
        yield* transaction.delete(taxFactAuthorityContracts).where(eq(taxFactAuthorityContracts.tenantId, tenant));
        yield* transaction.delete(taxOrderTaxFinalizations).where(eq(taxOrderTaxFinalizations.tenantId, tenant));
      }
    }),
  );

/** Seller A holds one authority contract and one source assertion, both attributed to `principalId`. */
const acquireSeededDatabase = Effect.gen(function* acquireTaxPrivacyTestDatabase() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  const contract = yield* Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
    authority: { authorityFrom: '2026-01-01T00:00:00.000Z', evidenceSourceRefs: [], systemOfRecordRef: 'erp.finance' },
    factFamily: FACT_FAMILY,
    provenanceRef: 'acceptance:privacy',
    reason: 'Govern VAT registration authority',
    stableCode: 'vat-registration',
  });
  yield* runScoped(runtime, scopeA, (transaction) =>
    taxAuthorityGovernancePersistenceForScope(transaction, scopeA).establishContract({
      ...contract,
      ...invocation(scopeA),
    }),
  );
  const assertion = yield* Schema.decodeEffect(RecordTaxSourceAssertionPayloadSchema)({
    factFamily: FACT_FAMILY,
    jurisdiction: 'CZ_DOMESTIC',
    provenanceRef: 'acceptance:privacy',
    reason: 'Record seller VAT registration evidence',
    registrationMeaning: 'REGISTERED',
    sourceAssertionKey: 'erp-assertion-privacy',
    sourceRecordRef: 'erp-record-privacy',
    sourceRef: 'erp.finance',
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  yield* runScoped(runtime, scopeA, (transaction) =>
    taxSourceAssertionPersistenceForScope(transaction, scopeA).recordAssertion({
      ...assertion,
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
      expect(foundIn(result, 'SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY')).toEqual(['tax-source-assertion']);
      expect(foundIn(result, 'TAX_FACT_AUTHORITY_CONTRACT_HISTORY').toSorted(byText)).toEqual([
        'tax-fact-authority-contract',
        'tax-fact-authority-contract-revision',
      ]);
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
        'tax-fact-authority-contract',
        'tax-fact-authority-contract-revision',
        'tax-source-assertion',
      ]);
      expect(foundIn(attributed, 'SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY')).toEqual([]);
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
