import { Schema } from 'effect';

type RepositoryPath = `app/${string}`;

const CONTRACT_SCHEMA_PROOF_KIND = 'contract-schema';
const DATABASE_CONTRACT_PROOF_KIND = 'database-contract';
const DEFERRED_BOUNDARY_PROOF_KIND = 'deferred-boundary';
const OWNER_INTEGRATION_PROOF_KIND = 'owner-integration';
const OWNER_SERVICE_CONTRACT_PROOF_KIND = 'owner-service-contract';
const PRODUCTION_SERVICE_PROOF_KIND = 'production-service';
const UNRESOLVED_GAP_PROOF_KIND = 'unresolved-gap';
export const Issue890ProofKindSchema = Schema.Literals([
  CONTRACT_SCHEMA_PROOF_KIND,
  DATABASE_CONTRACT_PROOF_KIND,
  DEFERRED_BOUNDARY_PROOF_KIND,
  OWNER_INTEGRATION_PROOF_KIND,
  OWNER_SERVICE_CONTRACT_PROOF_KIND,
  PRODUCTION_SERVICE_PROOF_KIND,
  UNRESOLVED_GAP_PROOF_KIND,
]);
export type Issue890ProofKind = typeof Issue890ProofKindSchema.Type;

const CURRENT_SUPPORTED_CURRENCIES_READ_PATH = 'app/verticals/pricing/src/api/current-supported-currencies.read.ts';
const NOT_APPLICABLE_STATUS = 'not-applicable';
const PRICE_DEFINITION_POSTGRES_TEST_PATH = 'app/verticals/pricing/tests/integration/price-definition-postgres.test.ts';
const PRICE_PERSISTENCE_SERVICE_PATH = 'app/verticals/pricing/src/services/price-persistence.service.ts';
const CONFIRMATION_PUBLICATION_BOUNDARY_TEST_PATH =
  'app/verticals/pricing/tests/unit/commitment-confirmation-publication-boundary.test.ts';
const CONFIRMATION_PUBLICATION_BOUNDARY = {
  disposition: 'intentionally-unpublished',
  issue: '#902',
  status: 'park',
} as const;

interface Issue890EvidenceRowBase {
  readonly deferredProductionPublication?: typeof CONFIRMATION_PUBLICATION_BOUNDARY;
  readonly id: string;
  readonly invariant: string;
  readonly owningNowIssue: `#${number}`;
  readonly proofKind: Issue890ProofKind;
}

export interface Issue890ProvedEvidenceRow extends Issue890EvidenceRowBase {
  readonly productionRefs: readonly [RepositoryPath, ...RepositoryPath[]];
  readonly status: 'proved';
  readonly testRefs: readonly [RepositoryPath, ...RepositoryPath[]];
}

export interface Issue890UnresolvedEvidenceRow extends Issue890EvidenceRowBase {
  readonly productionRefs: readonly RepositoryPath[];
  readonly reason: string;
  readonly status: 'not-applicable' | 'unresolved';
  readonly testRefs: readonly RepositoryPath[];
}

export type Issue890OwnerEvidenceRow = Issue890ProvedEvidenceRow | Issue890UnresolvedEvidenceRow;

export const ISSUE_890_REQUIRED_INVARIANT_IDS = [
  'exact-candidate-binding',
  'concrete-variant-selection',
  'occurrence-cardinality',
  'commercial-scope',
  'storefront-exclusion',
  'tenant-currency-support',
  'launch-currency-czk-only',
  'price-group-interpretation-and-fallback',
  'exact-current-price-outcomes',
  'quantity-tiers',
  'discount-families',
  'discount-layers-and-cardinality',
  'whole-purchase-conservation',
  'whole-purchase-sub-cent-fixture',
  'commercial-fees',
  'promotion-owner-boundary',
  'zero-floor-governance',
  'exact-arithmetic',
  'line-rounding-boundary',
  'commercial-total-reconciliation',
  'material-currentness',
  'owner-final-fence',
  'bounded-current-retry',
  'quotation-semantics',
  'current-backed-confirmation-issuance',
  'quotation-backed-confirmation-issuance',
  'confirmation-renewal',
  'accepted-and-downstream-handoffs',
  'atomic-authorization-permissions',
  'tenant-and-legal-entity-isolation',
  'customer-safe-evidence',
  'authorized-internal-evidence',
  'idempotent-write-replay',
  'concurrent-write-serialization',
  'lost-response-recovery',
  'actor-bound-result-lookup',
  'now-migration-evidence',
  'now-recovery-and-reconciliation',
  'list-endpoint',
  'search-endpoint',
  'export-endpoint',
] as const;

/**
 * Executable evidence inventory for #890. `proved` means the referenced production and test files
 * exist and are expected to be exercised by owner acceptance. It does not claim that PARK consumers
 * have adopted a boundary or that an intentionally unpublished endpoint is production-composed.
 * `unresolved` rows are deliberate failing-frontier documentation for the remediation plans; they
 * must not be interpreted as accepted evidence.
 */
export const ISSUE_890_OWNER_EVIDENCE_MAP = [
  {
    id: 'exact-candidate-binding',
    invariant: 'One decision is bound to one exact whole candidate and its stable occurrences.',
    owningNowIssue: '#751',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/pricing-decision.ts',
      'app/verticals/pricing/src/services/current-pricing-decision-whole-evaluation.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/packages/pricing-contracts/tests/unit/pricing-decision.test.ts',
      'app/verticals/pricing/tests/unit/current-pricing-decision-whole-evaluation-service.test.ts',
    ],
  },
  {
    id: 'concrete-variant-selection',
    invariant: 'Every priced occurrence carries one concrete Catalog Variant selection.',
    owningNowIssue: '#752',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/pricing-decision.ts',
      'app/packages/pricing-contracts/src/domain/quantity-unit-package-basis.ts',
    ],
    proofKind: CONTRACT_SCHEMA_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/catalog-selection-evidence.test.ts',
      'app/verticals/pricing/tests/unit/quantity-unit-package-basis-issue-769-runtime-acceptance.test.ts',
    ],
  },
  {
    id: 'occurrence-cardinality',
    invariant: 'Pricing preserves exactly one published result for every original occurrence.',
    owningNowIssue: '#751',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/commercial-total.ts',
      'app/verticals/pricing/src/services/commercial-total-projection.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/commercial-total-projection-service.test.ts',
      'app/verticals/pricing/tests/unit/commercial-totals-issue-780-acceptance.test.ts',
    ],
  },
  {
    id: 'commercial-scope',
    invariant: 'Price identity uses exact selling legal entity, Channel, and Commerce Market scope.',
    owningNowIssue: '#758',
    productionRefs: ['app/packages/pricing-contracts/src/domain/pricing-commercial-scope.ts'],
    proofKind: CONTRACT_SCHEMA_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/packages/pricing-contracts/tests/unit/commercial-context-scope-acceptance.test.ts'],
  },
  {
    id: 'storefront-exclusion',
    invariant: 'Storefront cannot select or participate in canonical monetary identity.',
    owningNowIssue: '#758',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/pricing-commercial-scope.ts',
      'app/packages/pricing-contracts/src/domain/price-definition.ts',
    ],
    proofKind: CONTRACT_SCHEMA_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/packages/pricing-contracts/tests/unit/commercial-context-scope-acceptance.test.ts',
      'app/packages/pricing-contracts/tests/unit/price-definition.test.ts',
    ],
  },
  {
    id: 'tenant-currency-support',
    invariant: 'Currency Support is a versioned Tenant capability with owner evidence.',
    owningNowIssue: '#759',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/currency-support.ts',
      CURRENT_SUPPORTED_CURRENCIES_READ_PATH,
    ],
    proofKind: OWNER_INTEGRATION_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/tenant-currency-support-read-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/tenant-currency-support-management-acceptance.test.ts',
    ],
  },
  {
    id: 'launch-currency-czk-only',
    invariant: 'Authoritative Launch Currency Support is exactly the set {CZK}.',
    owningNowIssue: '#759',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/currency-support.ts',
      'app/verticals/pricing/src/services/exact-decimal-profile.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/packages/pricing-contracts/tests/unit/tenant-currency-support-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/exact-decimal-profile-service.test.ts',
    ],
  },
  {
    id: 'price-group-interpretation-and-fallback',
    invariant: 'Price Group evidence distinguishes ASSIGNED, legitimate NONE, and broken states before fallback.',
    owningNowIssue: '#761',
    productionRefs: [
      'app/verticals/pricing/src/services/price-group-interpretation.service.ts',
      'app/verticals/pricing/src/services/price-group-fallback.service.ts',
    ],
    proofKind: OWNER_INTEGRATION_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/price-group-interpretation-issue-761-runtime-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/price-group-fallback-issue-762-runtime-acceptance.test.ts',
    ],
  },
  {
    id: 'exact-current-price-outcomes',
    invariant: 'Exact Current lookup returns authoritative found, absent, conflict, invalid, or unverifiable outcomes.',
    owningNowIssue: '#763',
    productionRefs: [
      'app/verticals/pricing/src/services/exact-price-resolution.service.ts',
      'app/verticals/pricing/src/services/exact-price-conflict.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/exact-price-resolution-issue-763-runtime-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/price-conflicts-issue-764-runtime-acceptance.test.ts',
    ],
  },
  {
    id: 'quantity-tiers',
    invariant:
      'Quantity Tiers use versioned definitions, inclusive thresholds, bounded aggregation, and compatible basis evidence.',
    owningNowIssue: '#766',
    productionRefs: [
      'app/verticals/pricing/src/services/quantity-tier-selection.service.ts',
      'app/verticals/pricing/src/services/quantity-tier-aggregation.service.ts',
      'app/verticals/pricing/src/services/quantity-unit-package-basis.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/quantity-tier-definition-runtime-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quantity-tier-threshold-selection-issue-767-runtime-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quantity-tier-aggregation-issue-768-runtime-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quantity-unit-package-basis-issue-769-runtime-acceptance.test.ts',
    ],
  },
  {
    id: 'discount-families',
    invariant: 'Catalog and contractual Discount families retain explicit audience, scope, and effect meaning.',
    owningNowIssue: '#770',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/discount.ts',
      'app/verticals/pricing/src/services/discount-applicability.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/packages/pricing-contracts/tests/unit/pricing-owned-discount-types-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/discount-applicability-issue-771-runtime-acceptance.test.ts',
    ],
  },
  {
    id: 'discount-layers-and-cardinality',
    invariant: 'Supported Discount layers compose independently with at most one contribution per supported path.',
    owningNowIssue: '#772',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/discount-composition.ts',
      'app/verticals/pricing/src/services/discount-composition.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/discount-composition-issue-772-acceptance.test.ts'],
  },
  {
    id: 'whole-purchase-conservation',
    invariant:
      'Whole-purchase allocation excludes ineligible recipients and preserves contribution and recipient capacity.',
    owningNowIssue: '#774',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/discount-fee-allocation.ts',
      'app/verticals/pricing/src/services/discount-fee-allocation.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/discount-fee-allocation-issue-774-acceptance.test.ts'],
  },
  {
    id: 'whole-purchase-sub-cent-fixture',
    invariant: 'The 9.7097 + 90.2975 basis conserves an exact 100 allocation from 100.0072.',
    owningNowIssue: '#774',
    productionRefs: ['app/verticals/pricing/src/services/discount-fee-allocation.service.ts'],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/discount-fee-allocation-issue-774-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/line-value-calculation-issue-779-acceptance.test.ts',
    ],
  },
  {
    id: 'commercial-fees',
    invariant: 'Recycling and Copyright Fees support exact per-line and per-unit bases with conflict-safe composition.',
    owningNowIssue: '#773',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/commercial-fee.ts',
      'app/verticals/pricing/src/services/commercial-fee-calculation.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/commercial-fee-calculation-issue-773-acceptance.test.ts'],
  },
  {
    id: 'promotion-owner-boundary',
    invariant: 'Pricing accepts exact owner contributions without implementing parked Promotion eligibility or usage.',
    owningNowIssue: '#775',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/promotion-contribution.ts',
      'app/verticals/pricing/src/services/promotion-contribution-composition.service.ts',
    ],
    proofKind: DEFERRED_BOUNDARY_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/promotion-contribution-issue-775-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/promotion-composition-issue-776-acceptance.test.ts',
    ],
  },
  {
    id: 'zero-floor-governance',
    invariant: 'A negative raw line can reach zero only through a matching governed ZERO_FLOOR authorization.',
    owningNowIssue: '#779',
    productionRefs: [
      'app/verticals/pricing/src/services/zero-floor-authorization-evaluator.service.ts',
      'app/verticals/pricing/src/services/line-value-composition.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/line-value-calculation-issue-779-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/current-pricing-decision-zero-floor-multiline-issue-790.test.ts',
    ],
  },
  {
    id: 'exact-arithmetic',
    invariant: 'All Pricing arithmetic is exact decimal with explicit currency precision and bounded failure.',
    owningNowIssue: '#777',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/exact-decimal.ts',
      'app/verticals/pricing/src/services/exact-decimal-profile.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/exact-decimal-and-precision-issue-777-acceptance.test.ts'],
  },
  {
    id: 'line-rounding-boundary',
    invariant: 'Publication performs one final HALF_UP line boundary and retains the signed rounding adjustment.',
    owningNowIssue: '#781',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/rounding-boundary.ts',
      'app/verticals/pricing/src/services/line-value-publication.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/rounding-boundaries-issue-781-acceptance.test.ts'],
  },
  {
    id: 'commercial-total-reconciliation',
    invariant: 'The canonical pre-Tax total equals the sum of published rounded lines with every delta counted once.',
    owningNowIssue: '#780',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/commercial-total.ts',
      'app/verticals/pricing/src/services/commercial-totals.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/commercial-totals-issue-780-acceptance.test.ts'],
  },
  {
    id: 'material-currentness',
    invariant: 'Material facts carry owner-verifiable Currentness and Set Completeness evidence.',
    owningNowIssue: '#786',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/material-evidence.ts',
      'app/verticals/pricing/src/services/material-evidence-assembly.service.ts',
    ],
    proofKind: OWNER_INTEGRATION_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/material-evidence-issue-786-acceptance.test.ts'],
  },
  {
    id: 'owner-final-fence',
    invariant: 'The Current decision revalidates owner evidence at a final fence before publication.',
    owningNowIssue: '#787',
    productionRefs: [
      'app/verticals/pricing/src/integrations/current-pricing-decision-owner-final-fence.ts',
      'app/verticals/pricing/src/services/material-evidence-final-validation.service.ts',
    ],
    proofKind: OWNER_INTEGRATION_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/current-pricing-decision-owner-final-fence-issue-790.test.ts',
      'app/verticals/pricing/tests/unit/material-evidence-final-validation-issue-786.test.ts',
    ],
  },
  {
    id: 'bounded-current-retry',
    invariant: 'A stale Current evaluation retries from one coherent fresh owner state without merging states.',
    owningNowIssue: '#787',
    productionRefs: ['app/verticals/pricing/src/services/ordinary-current-pricing-evaluation.service.ts'],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/ordinary-current-pricing-retry-issue-787-acceptance.test.ts'],
  },
  {
    id: 'quotation-semantics',
    invariant:
      'Immutable exact Quotations retain valid quoted terms while separately revalidating authenticity and binding.',
    owningNowIssue: '#782',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/quotation.ts',
      'app/verticals/pricing/src/services/quotation-revalidation.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/current-decision-vs-quotation-issue-782-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quotation-scope-issue-783-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quotation-validity-issue-784-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/quotation-revalidation-issue-785-acceptance.test.ts',
    ],
  },
  {
    deferredProductionPublication: CONFIRMATION_PUBLICATION_BOUNDARY,
    id: 'current-backed-confirmation-issuance',
    invariant:
      'The Pricing owner service contract creates one immutable short-lived Current-backed proof for the exact Attempt and Bundle; production endpoint publication is intentionally deferred to PARK #902.',
    owningNowIssue: '#788',
    productionRefs: ['app/verticals/pricing/src/services/current-backed-confirmation-issuance.service.ts'],
    proofKind: OWNER_SERVICE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/current-backed-confirmation-issuance-service.test.ts',
      CONFIRMATION_PUBLICATION_BOUNDARY_TEST_PATH,
    ],
  },
  {
    deferredProductionPublication: CONFIRMATION_PUBLICATION_BOUNDARY,
    id: 'quotation-backed-confirmation-issuance',
    invariant:
      'The Pricing owner service contract preserves quoted 900 terms while ordinary Current may be 950; production endpoint publication is intentionally deferred to PARK #902.',
    owningNowIssue: '#788',
    productionRefs: ['app/verticals/pricing/src/services/quotation-backed-confirmation-issuance.service.ts'],
    proofKind: OWNER_SERVICE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/quotation-backed-confirmation-issuance-service.test.ts',
      CONFIRMATION_PUBLICATION_BOUNDARY_TEST_PATH,
    ],
  },
  {
    deferredProductionPublication: CONFIRMATION_PUBLICATION_BOUNDARY,
    id: 'confirmation-renewal',
    invariant:
      'The Pricing owner service contract renews an unchanged Attempt and Bundle across both source paths; production endpoint publication is intentionally deferred to PARK #902.',
    owningNowIssue: '#788',
    productionRefs: ['app/verticals/pricing/src/services/commitment-confirmation-renewal.service.ts'],
    proofKind: OWNER_SERVICE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/commitment-confirmation-renewal-issue-788.test.ts',
      CONFIRMATION_PUBLICATION_BOUNDARY_TEST_PATH,
    ],
  },
  {
    id: 'accepted-and-downstream-handoffs',
    invariant:
      'Pricing preserves immutable Accepted terms and exposes Pricing-owned boundaries without claiming PARK consumer adoption.',
    owningNowIssue: '#789',
    productionRefs: [
      'app/packages/pricing-contracts/src/domain/accepted-order-handoff.ts',
      'app/packages/pricing-contracts/src/domain/pricing-owner-handoff.ts',
      'app/packages/pricing-contracts/src/domain/price-reconfirmation.ts',
    ],
    proofKind: DEFERRED_BOUNDARY_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/pricing-accepted-order-handoff-issue-789-acceptance.test.ts',
      'app/packages/pricing-contracts/tests/unit/pricing-owner-handoff.test.ts',
      'app/packages/pricing-contracts/tests/unit/price-reconfirmation.test.ts',
    ],
  },
  {
    id: 'atomic-authorization-permissions',
    invariant:
      'Every Pricing read is classified as customer-safe owner access, actor-bound Action result lookup, or an internal canonical read guarded by a generated atomic permission; writes remain explicit Actions.',
    owningNowIssue: '#799',
    productionRefs: [
      'app/verticals/pricing/shared/permissions/pricing-commercial-fee-read.ts',
      'app/verticals/pricing/shared/permissions/pricing-currency-support-read.ts',
      'app/verticals/pricing/shared/permissions/pricing-exact-price-resolution-read.ts',
      'app/verticals/pricing/shared/permissions/pricing-price-read.ts',
      'app/verticals/pricing/src/api/current-pricing-decision.read.ts',
      CURRENT_SUPPORTED_CURRENCIES_READ_PATH,
      'app/verticals/pricing/src/api/exact-price-resolution.read.ts',
      'app/verticals/pricing/src/api/price-result-lookup.read.ts',
      'app/verticals/pricing/vertical.manifest.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/scripts/scaffolding/tests/permission-generator.test.mts',
      'app/verticals/pricing/tests/unit/actor-bound-result-lookup-security.test.ts',
      'app/verticals/pricing/tests/unit/current-pricing-decision-read.test.ts',
      'app/verticals/pricing/tests/unit/pricing-read-access-boundary.test.ts',
    ],
  },
  {
    id: 'tenant-and-legal-entity-isolation',
    invariant: 'Authorization fails closed across Tenant, selling legal entity, and commercial context boundaries.',
    owningNowIssue: '#799',
    productionRefs: [
      'app/verticals/pricing/src/actions/define-price.action.ts',
      'app/verticals/pricing/src/actions/set-supported-currencies.action.ts',
      CURRENT_SUPPORTED_CURRENCIES_READ_PATH,
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/pricing-currency-support-authorization-matrix-issue-799.test.ts',
      'app/verticals/pricing/tests/unit/pricing-read-access-boundary.test.ts',
    ],
  },
  {
    id: 'customer-safe-evidence',
    invariant:
      'Customer-safe output is allowlisted and does not expose internal source, audit, or diagnostic evidence.',
    owningNowIssue: '#800',
    productionRefs: [
      'app/verticals/pricing/src/services/source-evidence-projection.service.ts',
      'app/verticals/pricing/src/services/commercial-total-projection.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/source-evidence-projection-service.test.ts',
      'app/verticals/pricing/tests/unit/commercial-total-projection-service.test.ts',
    ],
  },
  {
    deferredProductionPublication: CONFIRMATION_PUBLICATION_BOUNDARY,
    id: 'authorized-internal-evidence',
    invariant:
      'Authorized internal evidence remains lossless enough for owner diagnosis and lineage; Confirmation management uses the standard audited Action and append-only owner persistence while endpoint publication remains deferred to PARK #902.',
    owningNowIssue: '#800',
    productionRefs: [
      'app/verticals/pricing/src/actions/manage-commitment-confirmation.action.ts',
      'app/verticals/pricing/src/services/commitment-confirmation-persistence.service.ts',
      'app/verticals/pricing/src/services/source-evidence-projection.service.ts',
      'app/verticals/pricing/drizzle/20260928103000_pricing_commitment_confirmations_v1/migration.sql',
    ],
    proofKind: OWNER_SERVICE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/manage-commitment-confirmation-action-issue-800.test.ts',
      'app/verticals/pricing/tests/unit/commitment-confirmation-database-contract.test.ts',
      CONFIRMATION_PUBLICATION_BOUNDARY_TEST_PATH,
      'app/verticals/pricing/tests/unit/source-evidence-projection-service.test.ts',
    ],
  },
  {
    id: 'idempotent-write-replay',
    invariant: 'Write replay is bound to the original exact intent and cannot disguise a new request as a no-op.',
    owningNowIssue: '#802',
    productionRefs: [PRICE_PERSISTENCE_SERVICE_PATH],
    proofKind: DATABASE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [PRICE_DEFINITION_POSTGRES_TEST_PATH],
  },
  {
    id: 'concurrent-write-serialization',
    invariant: 'First creates and competing schedule mutations serialize with a typed stale/conflict loser.',
    owningNowIssue: '#802',
    productionRefs: [
      PRICE_PERSISTENCE_SERVICE_PATH,
      'app/verticals/pricing/drizzle/20260927143143_pricing-price-routines-v1/migration.sql',
    ],
    proofKind: DATABASE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [PRICE_DEFINITION_POSTGRES_TEST_PATH],
  },
  {
    id: 'lost-response-recovery',
    invariant: 'A caller can recover a committed write after losing the original response without duplicating history.',
    owningNowIssue: '#802',
    productionRefs: ['app/verticals/pricing/src/api/price-result-lookup.read.ts', PRICE_PERSISTENCE_SERVICE_PATH],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/price-management-actions-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/price-result-lookup-issue-797.test.ts',
    ],
  },
  {
    id: 'actor-bound-result-lookup',
    invariant:
      'Result lookup is bound to the original actor, Tenant, legal entity, action kind, and invocation identity.',
    owningNowIssue: '#802',
    productionRefs: [
      'app/verticals/pricing/src/persistence/currency-support-persistence.ts',
      'app/verticals/pricing/src/services/commercial-fee-persistence.service.ts',
      'app/verticals/pricing/src/services/contractual-discount-persistence.service.ts',
      PRICE_PERSISTENCE_SERVICE_PATH,
      'app/verticals/pricing/src/services/quantity-tier-persistence.service.ts',
      'app/verticals/pricing/src/services/quotation-persistence.service.ts',
      'app/verticals/pricing/src/services/zero-floor-authorization-persistence.service.ts',
    ],
    proofKind: PRODUCTION_SERVICE_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/actor-bound-result-lookup-security.test.ts'],
  },
  {
    id: 'now-migration-evidence',
    invariant: 'NOW storage and runtime migrations are append-only, owner-local, and mechanically verified.',
    owningNowIssue: '#807',
    productionRefs: [
      'app/verticals/pricing/drizzle/20260927143130_pricing-price-foundation/migration.sql',
      'app/verticals/pricing/drizzle/20260927181231_tenant-currency-support-v1/migration.sql',
      'app/verticals/pricing/scripts/verify-db-schema.mts',
    ],
    proofKind: DATABASE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: ['app/verticals/pricing/tests/unit/database-schema-contract.test.ts'],
  },
  {
    id: 'now-recovery-and-reconciliation',
    invariant:
      'Qualified legacy identities, baselines, unknown writes, per-target retries, lineage, correction, and rollback have executable recovery proof.',
    owningNowIssue: '#807',
    productionRefs: [
      'app/verticals/pricing/src/actions/compensate-currency-support-recovery.action.ts',
      'app/verticals/pricing/src/services/currency-support-recovery.service.ts',
      'app/verticals/pricing/src/services/external-price-input-boundary.service.ts',
      PRICE_PERSISTENCE_SERVICE_PATH,
      'app/verticals/pricing/src/services/product-price-bulk.service.ts',
      'app/verticals/pricing/src/persistence/currency-support-persistence.ts',
      'app/verticals/pricing/drizzle/20260927181352_retire-legacy-currency-support-authority/migration.sql',
      'app/verticals/pricing/drizzle/20260927183819_freeze-legacy-currency-support-history/migration.sql',
      'app/verticals/pricing/drizzle/20261001180435_pricing-price-source-cross-identity-lineage-runtime-v1/migration.sql',
      'app/verticals/pricing/drizzle/20261001180624_pricing-currency-support-recovery-compensation-runtime-v1/migration.sql',
    ],
    proofKind: DATABASE_CONTRACT_PROOF_KIND,
    status: 'proved',
    testRefs: [
      'app/verticals/pricing/tests/unit/pricing-recovery-evidence-issue-807.test.ts',
      'app/verticals/pricing/tests/unit/price-management-actions-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/currency-support-recovery-issue-807.test.ts',
      'app/verticals/pricing/tests/unit/product-price-bulk-management-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/product-price-bulk.test.ts',
      'app/verticals/pricing/tests/unit/compensate-currency-support-recovery-action.test.ts',
      'app/verticals/pricing/tests/unit/currency-support-persistence.test.ts',
      PRICE_DEFINITION_POSTGRES_TEST_PATH,
      'app/verticals/pricing/tests/integration/external-price-source-authority-postgres.test.ts',
      'app/verticals/pricing/tests/integration/price-source-provenance-postgres.test.ts',
      'app/verticals/pricing/tests/integration/currency-support-result-lookup-postgres.test.ts',
    ],
  },
  {
    id: 'list-endpoint',
    invariant: 'Pricing exposes a general list endpoint requiring owner-acceptance evidence.',
    owningNowIssue: '#790',
    productionRefs: [],
    proofKind: UNRESOLVED_GAP_PROOF_KIND,
    reason:
      'N/A: #790 defines one exact whole-candidate Current decision read; no general Pricing list endpoint is in the NOW owner contract.',
    status: NOT_APPLICABLE_STATUS,
    testRefs: [],
  },
  {
    id: 'search-endpoint',
    invariant: 'Pricing exposes a general search endpoint requiring owner-acceptance evidence.',
    owningNowIssue: '#790',
    productionRefs: [],
    proofKind: UNRESOLVED_GAP_PROOF_KIND,
    reason: 'N/A: no Pricing search provider or search endpoint is defined by the NOW owner contract.',
    status: NOT_APPLICABLE_STATUS,
    testRefs: [],
  },
  {
    id: 'export-endpoint',
    invariant: 'Pricing exposes a customer or operator export endpoint requiring redaction evidence.',
    owningNowIssue: '#800',
    productionRefs: [],
    proofKind: UNRESOLVED_GAP_PROOF_KIND,
    reason:
      'N/A: no Pricing export endpoint is defined by the NOW owner contract; export sanitization becomes required only when such a surface is introduced.',
    status: NOT_APPLICABLE_STATUS,
    testRefs: [],
  },
] as const satisfies readonly Issue890OwnerEvidenceRow[];
