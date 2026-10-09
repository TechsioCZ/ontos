import { Schema } from 'effect';

export const ISSUE_807_EVIDENCE_OWNER_ISSUES = [797, 802, 803, 805, 807] as const;

export type Issue807EvidenceOwnerIssue = (typeof ISSUE_807_EVIDENCE_OWNER_ISSUES)[number];
export const Issue807EvidenceStatusSchema = Schema.Literals(['GAP', 'PARTIAL', 'PROVEN']);
export type Issue807EvidenceStatus = typeof Issue807EvidenceStatusSchema.Type;

const CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH =
  'verticals/pricing/src/services/currency-support-recovery.service.ts' as const;
const CURRENCY_SUPPORT_RECOVERY_TEST_PATH =
  'verticals/pricing/tests/unit/currency-support-recovery-issue-807.test.ts' as const;
const PRODUCT_PRICE_BULK_SERVICE_PATH = 'verticals/pricing/src/services/product-price-bulk.service.ts' as const;
const PRODUCT_PRICE_BULK_ACCEPTANCE_TEST_PATH =
  'verticals/pricing/tests/unit/product-price-bulk-management-acceptance.test.ts' as const;
const SET_SUPPORTED_CURRENCIES_TEST_PATH = 'verticals/pricing/tests/unit/set-supported-currencies.test.ts' as const;
const PRICE_SOURCE_PROVENANCE_SERVICE_PATH =
  'verticals/pricing/src/services/price-source-provenance.service.ts' as const;

export interface Issue807EvidenceReference {
  readonly path: `verticals/pricing/${string}`;
  readonly symbol: string;
}

export interface Issue807RecoveryEvidenceEntry {
  readonly claim: string;
  readonly gap: string | null;
  readonly id: string;
  readonly missingEvidence: readonly string[];
  readonly ownerIssues: readonly Issue807EvidenceOwnerIssue[];
  readonly production: readonly Issue807EvidenceReference[];
  readonly status: Issue807EvidenceStatus;
  readonly tests: readonly Issue807EvidenceReference[];
}

export const ISSUE_807_REQUIRED_OBLIGATION_IDS = [
  'recovery-state-taxonomy',
  'exact-price-identity',
  'explicit-tenant-baseline',
  'qualified-legacy-history',
  'tenant-isolation-and-launch-guard',
  'source-authority-runtime',
  'price-unknown-write-end-to-end',
  'per-target-bulk-persistence',
  'correction-lineage-end-to-end',
  'canonical-current-conflict',
  'expected-state-and-schedule',
  'gross-only-held',
  'zero-floor-governance',
  'accepted-history-immutability',
  'rollback-persistence',
  'single-authority-postgres',
] as const;

export const ISSUE_807_KNOWN_GAP_IDS = [] as const;

/**
 * Evidence inventory for #807. PROVEN is intentionally narrow: it means the cited production
 * symbol is exercised by the cited executable test, not that the whole recovery issue is done.
 * PARTIAL/GAP rows name the missing end-to-end proof so review cannot infer readiness from nearby
 * types, pure planners, mocked ports, or migration text.
 */
export const ISSUE_807_RECOVERY_EVIDENCE = [
  {
    claim: 'Recovery distinguishes ready, held, reconciled, applied, and conflicting outcomes.',
    gap: null,
    id: 'recovery-state-taxonomy',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'CurrencySupportRecoveryExecutionOutcome',
      },
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'planCurrencySupportRecovery',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'holds missing/duplicate mappings, an existing canonical authority, and additional-currency activation',
      },
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'looks up the original Action intent before retry and never repeats a proven commit',
      },
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'executes only when the original intent is absent and conflicts on a mismatched receipt',
      },
    ],
  },
  {
    claim: 'Recovery accepts only an exact Variant-based Price identity and never infers a target.',
    gap: null,
    id: 'exact-price-identity',
    missingEvidence: [],
    ownerIssues: [797, 803, 805, 807],
    production: [
      {
        path: 'verticals/pricing/src/services/external-price-input-boundary.service.ts',
        symbol: 'grantMatchesRequest',
      },
      {
        path: PRODUCT_PRICE_BULK_SERVICE_PATH,
        symbol: 'validateInput',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/pricing-price-management-actions-issue-797-acceptance.test.ts',
        symbol: 'requires exact Variant and Market Price identity and never admits Storefront as a monetary selector',
      },
      {
        path: 'verticals/pricing/tests/unit/external-price-input-boundary-issues-803-805.test.ts',
        symbol: 'rejects a grant for another exact key even when amount and transport source are identical',
      },
      {
        path: PRODUCT_PRICE_BULK_ACCEPTANCE_TEST_PATH,
        symbol: 'rejects omitted, substituted, or newly discovered Variant targets before owner execution',
      },
    ],
  },
  {
    claim:
      'Tenant Currency Support recovery derives {CZK} only from an explicit governed baseline, never legacy union/latest ranking.',
    gap: null,
    id: 'explicit-tenant-baseline',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'planCurrencySupportRecovery',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'creates one explicit CZK Tenant baseline while retaining divergent legacy values as history only',
      },
    ],
  },
  {
    claim: 'Legacy Currency Support rows retain exact source and mapping references as history-only evidence.',
    gap: null,
    id: 'qualified-legacy-history',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'qualifiedLegacyHistory',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'retaining divergent legacy values as history only',
      },
    ],
  },
  {
    claim: 'Recovery is Tenant-bound and cannot activate an additional Launch currency.',
    gap: null,
    id: 'tenant-isolation-and-launch-guard',
    missingEvidence: [],
    ownerIssues: [797, 807],
    production: [
      {
        path: 'verticals/pricing/src/actions/set-supported-currencies.action.ts',
        symbol: 'applySupportedCurrencies',
      },
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'UNAUTHORIZED_CURRENCY_ACTIVATION',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: SET_SUPPORTED_CURRENCIES_TEST_PATH,
        symbol: 'rejects cross-Principal acknowledgements and cross-Tenant expected state before persistence',
      },
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'additional-currency activation',
      },
    ],
  },
  {
    claim: 'A Pricing-owned, versioned authority and mapping grant gates an external Price assertion.',
    gap: null,
    id: 'source-authority-runtime',
    missingEvidence: [],
    ownerIssues: [803, 805, 807],
    production: [
      {
        path: 'verticals/pricing/src/services/external-price-input-boundary.service.ts',
        symbol: 'ExternalPriceSourceAuthorityPort',
      },
      {
        path: 'verticals/pricing/src/persistence/external-price-source-authority-persistence.ts',
        symbol: 'externalPriceSourceAuthorityForScope',
      },
      {
        path: 'verticals/pricing/drizzle/20261001164414_external-price-source-authority-runtime-v1/migration.sql',
        symbol: 'assess_external_price_source_authority_v1',
      },
      {
        path: 'verticals/pricing/drizzle/20261001164414_external-price-source-authority-runtime-v1/migration.sql',
        symbol: 'store_external_price_source_authority_grant_v1',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/external-price-input-boundary-issues-803-805.test.ts',
        symbol: 'accepts only a Pricing-owned grant for the exact authority, mapping, key, and effective instant',
      },
      {
        path: 'verticals/pricing/tests/unit/external-price-source-authority-persistence.test.ts',
        symbol: 'decodes one exact owner grant and fails closed on an ambiguous result',
      },
      {
        path: 'verticals/pricing/tests/integration/external-price-source-authority-postgres.test.ts',
        symbol: 'stores, resolves, and isolates exact external Price Source Authority grants in PostgreSQL',
      },
    ],
  },
  {
    claim: 'A lost Price response can be resolved against the original Action invocation before any retry.',
    gap: null,
    id: 'price-unknown-write-end-to-end',
    missingEvidence: [],
    ownerIssues: [797, 802, 807],
    production: [
      {
        path: 'verticals/pricing/src/services/price-persistence.service.ts',
        symbol: 'pricePersistenceForScope',
      },
      {
        path: 'verticals/pricing/src/api/price-result-lookup.read.ts',
        symbol: 'readPriceResult',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/price-management-actions-acceptance.test.ts',
        symbol: 'reconciles indeterminate Define and Revise writes before permitting any retry',
      },
      {
        path: 'verticals/pricing/tests/integration/price-definition-postgres.test.ts',
        symbol: 'price-definition:lost-response-retry',
      },
      {
        path: 'verticals/pricing/tests/unit/price-result-lookup-issue-797.test.ts',
        symbol: 'Price governed result lookup issue #797',
      },
    ],
  },
  {
    claim: 'Product bulk preserves a fixed Variant snapshot and reconciles each original intent independently.',
    gap: null,
    id: 'per-target-bulk-persistence',
    missingEvidence: [],
    ownerIssues: [797, 802, 807],
    production: [
      {
        path: PRODUCT_PRICE_BULK_SERVICE_PATH,
        symbol: 'makeProductPriceBulkService',
      },
      {
        path: PRODUCT_PRICE_BULK_SERVICE_PATH,
        symbol: 'makeProductPriceBulkCommandPort',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: PRODUCT_PRICE_BULK_ACCEPTANCE_TEST_PATH,
        symbol: 'keeps the original Product snapshot fixed and reports per-Variant partial outcomes',
      },
      {
        path: PRODUCT_PRICE_BULK_ACCEPTANCE_TEST_PATH,
        symbol: 'returns an indeterminate per-target outcome when owner result lookup is unavailable',
      },
      {
        path: PRODUCT_PRICE_BULK_ACCEPTANCE_TEST_PATH,
        symbol: 'does not attach a replayed Price result from a different fixed snapshot target',
      },
      {
        path: 'verticals/pricing/tests/unit/product-price-bulk.test.ts',
        symbol: 'retries only an owner-confirmed open intent and keeps unavailable lookup indeterminate',
      },
    ],
  },
  {
    claim: 'Source correction and supersession preserve trusted actor and predecessor references.',
    gap: null,
    id: 'correction-lineage-end-to-end',
    missingEvidence: [],
    ownerIssues: [797, 803, 807],
    production: [
      {
        path: PRICE_SOURCE_PROVENANCE_SERVICE_PATH,
        symbol: 'sourceLineageFor',
      },
      {
        path: PRICE_SOURCE_PROVENANCE_SERVICE_PATH,
        symbol: 'preparePriceSourceEvidence',
      },
      {
        path: 'verticals/pricing/drizzle/20261001180435_pricing-price-source-cross-identity-lineage-runtime-v1/migration.sql',
        symbol: 'bind_price_source_provenance_v1',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/price-source-provenance-service.test.ts',
        symbol: 'injects the trusted actor into correction lineage',
      },
      {
        path: 'verticals/pricing/tests/integration/price-definition-postgres.test.ts',
        symbol: 'supersededSourceAssertionId',
      },
      {
        path: 'verticals/pricing/tests/integration/price-source-provenance-postgres.test.ts',
        symbol: 'links an identity-changing source correction from the old exact Price to its replacement',
      },
    ],
  },
  {
    claim: 'Competing Current exact Price truths remain a conflict even when values are equal.',
    gap: null,
    id: 'canonical-current-conflict',
    missingEvidence: [],
    ownerIssues: [802, 807],
    production: [
      {
        path: 'verticals/pricing/src/services/exact-price-conflict.service.ts',
        symbol: 'classifyExactPriceOwnerLookup',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/exact-price-conflict-service.test.ts',
        symbol: 'retains authorized equal-amount claimants while returning only redacted public identities',
      },
    ],
  },
  {
    claim: 'Expected Current and schedule acknowledgement are checked before unchanged/no-op acceptance.',
    gap: null,
    id: 'expected-state-and-schedule',
    missingEvidence: [],
    ownerIssues: [797, 802, 807],
    production: [
      {
        path: 'verticals/pricing/src/actions/set-supported-currencies.action.ts',
        symbol: 'applySupportedCurrencies',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: SET_SUPPORTED_CURRENCIES_TEST_PATH,
        symbol: 'checks expected state before recognizing a no-op',
      },
      {
        path: SET_SUPPORTED_CURRENCIES_TEST_PATH,
        symbol: 'returns a blocking future-schedule acknowledgement challenge and preserves typed stale conflicts',
      },
    ],
  },
  {
    claim: 'Gross-only assertions remain held until authoritative pre-Tax normalization is present.',
    gap: null,
    id: 'gross-only-held',
    missingEvidence: [],
    ownerIssues: [803, 805, 807],
    production: [
      {
        path: PRICE_SOURCE_PROVENANCE_SERVICE_PATH,
        symbol: 'preparePriceSourceEvidence',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/price-source-provenance-service.test.ts',
        symbol:
          'holds gross assertions without authoritative normalization and rejects implicit currency or Unit mapping',
      },
    ],
  },
  {
    claim: 'ZERO_FLOOR recovery remains bounded, versioned governance rather than a result clamp.',
    gap: null,
    id: 'zero-floor-governance',
    missingEvidence: [],
    ownerIssues: [797, 807],
    production: [
      {
        path: 'verticals/pricing/src/services/zero-floor-authorization-administration.service.ts',
        symbol: 'makeZeroFloorAuthorizationAdministration',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/pricing-price-management-actions-issue-797-acceptance.test.ts',
        symbol: 'allows bounded ZERO_FLOOR reuse but rejects unchanged evidence for expanded scope or bounds',
      },
    ],
  },
  {
    claim: 'Recovery cannot reinterpret accepted terms or discard qualified legacy references.',
    gap: null,
    id: 'accepted-history-immutability',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: 'verticals/pricing/src/services/accepted-order-handoff-serializer.service.ts',
        symbol: 'serializePricingAcceptedOrderHandoff',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/accepted-order-handoff-qualified-legacy-history.test.ts',
        symbol: 'preserves original partitioned evidence and exact accepted terms without Current reinterpretation',
      },
    ],
  },
  {
    claim:
      'Rollback after a proven Currency Support commit requires a new governed transition and never deletes history.',
    gap: null,
    id: 'rollback-persistence',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_SERVICE_PATH,
        symbol: 'evaluateCurrencySupportRecoveryRollback',
      },
      {
        path: 'verticals/pricing/src/actions/compensate-currency-support-recovery.action.ts',
        symbol: 'compensateCurrencySupportRecoveryAction',
      },
      {
        path: 'verticals/pricing/src/persistence/currency-support-persistence.ts',
        symbol: 'compensateTenantCurrencySupportRecoveryRoutine',
      },
      {
        path: 'verticals/pricing/drizzle/20261001180624_pricing-currency-support-recovery-compensation-runtime-v1/migration.sql',
        symbol: 'compensate_tenant_currency_support_recovery_v1',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: CURRENCY_SUPPORT_RECOVERY_TEST_PATH,
        symbol: 'rolls back safely without deleting a commit or restoring the legacy writable authority',
      },
      {
        path: 'verticals/pricing/tests/unit/compensate-currency-support-recovery-action.test.ts',
        symbol: 'binds compensation to the trusted Action identity and exact committed result',
      },
      {
        path: 'verticals/pricing/tests/unit/currency-support-persistence.test.ts',
        symbol: 'binds recovery compensation to the original committed result and a new schedule revision',
      },
      {
        path: 'verticals/pricing/tests/integration/currency-support-result-lookup-postgres.test.ts',
        symbol: 'persists rollback as a new governed schedule, denies legacy writes, and survives failure injection',
      },
    ],
  },
  {
    claim: 'Canonical Tenant Currency Support is the only writable authority and legacy rows are history-only.',
    gap: null,
    id: 'single-authority-postgres',
    missingEvidence: [],
    ownerIssues: [807],
    production: [
      {
        path: 'verticals/pricing/drizzle/20260927181352_retire-legacy-currency-support-authority/migration.sql',
        symbol: 'pricing_currency_support_legacy_scope_update',
      },
      {
        path: 'verticals/pricing/drizzle/20260927183819_freeze-legacy-currency-support-history/migration.sql',
        symbol: 'pricing_currency_support_legacy_scope_insert',
      },
    ],
    status: 'PROVEN',
    tests: [
      {
        path: 'verticals/pricing/tests/unit/database-schema-contract.test.ts',
        symbol: 'retires the legacy mutable authority without deriving a baseline',
      },
      {
        path: 'verticals/pricing/tests/integration/currency-support-result-lookup-postgres.test.ts',
        symbol: 'persists rollback as a new governed schedule, denies legacy writes, and survives failure injection',
      },
    ],
  },
] as const satisfies readonly Issue807RecoveryEvidenceEntry[];
