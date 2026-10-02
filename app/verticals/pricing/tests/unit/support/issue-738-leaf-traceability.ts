import { Schema } from 'effect';

const COMMERCE_CUSTOMER_CONTEXT_OWNER = 'commerce-customer-context' as const;
const COMMERCE_MARKET_CATALOG_OWNER = 'commerce-market-catalog' as const;
const ISSUE_799_EXECUTION_STATUS_EVIDENCE =
  '#799 is open with exactly status:now in the live #738 scope review.' as const;
const PRICING_WORKSPACE_OWNER = 'pricing-workspace' as const;

export const Issue738TraceabilityOwnerSchema = Schema.Literals([
  'catalog',
  COMMERCE_CUSTOMER_CONTEXT_OWNER,
  COMMERCE_MARKET_CATALOG_OWNER,
  'core-runtime',
  'infrastructure',
  'pricing',
  PRICING_WORKSPACE_OWNER,
  'promotion',
]);
export type Issue738TraceabilityOwner = typeof Issue738TraceabilityOwnerSchema.Type;

export const ISSUE_738_FIXED_BASE = '94544ebc7c3444bb98212839f8725cf999af832e' as const;
export const ISSUE_738_REVIEWED_HEAD = '31fc67056a51300302e4b343d19ff443ee09e727' as const;

export const ISSUE_738_PRICING_OWNED_PATH_PREFIXES = [
  'app/packages/pricing-contracts/',
  'app/verticals/pricing/',
] as const;

export const ISSUE_738_OUT_OF_SCOPE_PATH_PREFIXES = ['app/packages/promotion-contracts/'] as const;

export const Issue738NonPricingDispositionSchema = Schema.Literals(['keep', 'remove', 'split']);
export type Issue738NonPricingDisposition = typeof Issue738NonPricingDispositionSchema.Type;

export interface Issue738NonPricingDispositionGroup {
  readonly approvalOrPrEvidence: string;
  readonly disposition: Issue738NonPricingDisposition;
  readonly exactIssueEvidence: string;
  readonly executionStatusEvidence: string;
  readonly hitlRequired: boolean;
  readonly id: string;
  readonly issues: readonly `#${number}`[];
  readonly owner: Issue738TraceabilityOwner;
  readonly paths: readonly [string, ...string[]];
  readonly reason: string;
  readonly requiredByNowPricingLeaves: readonly [`#${number}`, ...`#${number}`[]];
}

export type Issue738NonPricingScopeLedgerRow = Omit<Issue738NonPricingDispositionGroup, 'id' | 'paths'> & {
  readonly groupId: string;
  readonly path: string;
};

/**
 * Exhaustive disposition for every path outside Pricing and pricing-contracts in the union of the
 * immutable fixed-base-to-reviewed-head diff and the live worktree diff. The validator rejects an
 * uncovered or duplicated path and separately checks its accepted disposition in the live worktree.
 * Foreign-owner rows are kept only under the explicit HITL direction recorded for #738; no
 * PARK/LATER owner is activated.
 */
export const ISSUE_738_NON_PRICING_DISPOSITIONS = [
  {
    approvalOrPrEvidence:
      'No separate PR is required for Pricing-owned coordination artifacts; the #738 remediation review approved correcting their tracking-only meaning.',
    disposition: 'keep',
    exactIssueEvidence: 'Each plan basename identifies its exact tracking issue: #741, #742, or #743.',
    executionStatusEvidence: '#741, #742, and #743 are status:tracking in the supplied #738 review.',
    hitlRequired: false,
    id: 'pricing-coordination-plans',
    issues: ['#741', '#742', '#743'],
    owner: 'pricing',
    paths: [
      '.codex/plans/pricing-741-exact-resolution.plan.md',
      '.codex/plans/pricing-742-quantity-tiers.plan.md',
      '.codex/plans/pricing-743-discounts-fees.plan.md',
    ],
    reason:
      'Coordinates exact-resolution, quantity, discount, and fee NOW leaves without claiming parent implementation.',
    requiredByNowPricingLeaves: [
      '#761',
      '#762',
      '#763',
      '#764',
      '#765',
      '#766',
      '#767',
      '#768',
      '#769',
      '#770',
      '#771',
      '#772',
      '#773',
      '#774',
    ],
  },
  {
    approvalOrPrEvidence:
      'The supplied #738 review names these as active NOW Pricing leaves; the HITL authorized continuing with the existing local owner code without issue or PR mutation.',
    disposition: 'keep',
    exactIssueEvidence: 'The local #738 map ties this shared workspace integration to #759, #797, #802, and #807.',
    executionStatusEvidence: '#759, #797, #802, and #807 are status:now in the supplied #738 review.',
    hitlRequired: false,
    id: 'pricing-workspace-integration',
    issues: ['#759', '#797', '#802', '#807'],
    owner: PRICING_WORKSPACE_OWNER,
    paths: [
      'app/package.json',
      'app/pnpm-lock.yaml',
      'app/scripts/czech-launch-commerce-fixture.mts',
      'app/scripts/postgres/bootstrap-runtime-role.mts',
      'app/scripts/postgres/runtime-role-grants.mts',
      'app/scripts/integration/migrator-runtime-owner-access.test.mts',
      'app/scripts/tests/bootstrap-runtime-role.test.mts',
      'app/scripts/tests/czech-launch-commerce-fixture.test.mts',
      'app/scripts/tests/initialize-local-development.test.mts',
      'app/scripts/tests/provision-current-action-authorization.test.mts',
    ],
    reason:
      'Provides workspace-owned package, launch-fixture, Action provisioning, and least-privilege database integration required by the named NOW Pricing leaves.',
    requiredByNowPricingLeaves: ['#759', '#797', '#802', '#807'],
  },
  {
    approvalOrPrEvidence:
      'The HITL directed completion of the supplied #738 code review and then explicitly directed fixing the resulting PR checks without creating or mutating issues.',
    disposition: 'keep',
    exactIssueEvidence:
      '#890 requires executable owner acceptance and a complete evidence map; the supplied review also requires generated-boundary, database-boundary, typecheck, lint, and final integrated CI proof.',
    executionStatusEvidence: '#890 is an active status:now owner-acceptance leaf in the supplied #738 review.',
    hitlRequired: false,
    id: 'pricing-review-validation-infrastructure',
    issues: ['#890'],
    owner: 'infrastructure',
    paths: [
      '.github/workflows/ultramodern-workspace-gates.yml',
      'app/scripts/check-database-access-boundaries.mts',
      'app/scripts/generated-governed-http-boundary.mts',
      'app/scripts/scaffolding/tests/scaffold-generators.test.mts',
      'app/scripts/tests/database-access-boundaries.test.mts',
    ],
    reason:
      'Keeps the branch-specific acceptance test reproducible in CI and strengthens the existing static validators that prove Pricing does not expose database capabilities or disconnect its generated governed HTTP runtime.',
    requiredByNowPricingLeaves: ['#890'],
  },
  {
    approvalOrPrEvidence:
      'The HITL directed completing the supplied #738 review in this branch; these entries register generated Pricing owner shims in the repository lint boundary rather than weakening the underlying rules.',
    disposition: 'keep',
    exactIssueEvidence:
      '#755 owns the Price Definition contract, #790 owns the customer-safe Current Pricing read, and #890 requires their executable owner evidence to pass the final lint gate.',
    executionStatusEvidence: '#755, #790, and #890 are status:now in the supplied #738 review.',
    hitlRequired: false,
    id: 'pricing-generated-shim-lint-boundary',
    issues: ['#755', '#790', '#890'],
    owner: 'infrastructure',
    paths: ['app/oxlint.config.ts'],
    reason:
      'Registers only the exact Codesmith-style Pricing public contract and client shims exercised by the active Price Definition and Current Pricing owner surfaces.',
    requiredByNowPricingLeaves: ['#755', '#790', '#890'],
  },
  {
    approvalOrPrEvidence:
      'The #738 remediation must preserve Lean Core while composing approved Commerce owner clients; the repository boundary checker therefore records only the exact Pricing importer/client pairs exercised by NOW owner integration.',
    disposition: 'keep',
    exactIssueEvidence:
      '#753, #761, #786, and #790 require Pricing to consume the approved Customer Context owner contracts without importing private owner implementations.',
    executionStatusEvidence: '#753, #761, #786, and #790 are status:now in the supplied #738 review.',
    hitlRequired: false,
    id: 'pricing-commerce-lean-core-seams',
    issues: ['#753', '#761', '#786', '#790'],
    owner: 'infrastructure',
    paths: ['app/scripts/check-lean-core-dependencies.mts', 'app/scripts/tests/lean-core-dependencies.test.mts'],
    reason:
      'Allows only the named public Commerce client seams used by Pricing and proves an unlisted importer remains rejected.',
    requiredByNowPricingLeaves: ['#753', '#761', '#786', '#790'],
  },
  {
    approvalOrPrEvidence:
      'The #738 remediation generated atomic Pricing read Permissions for NOW issue #799; the shared Core permission model change is required to represent their module-scoped targets.',
    disposition: 'keep',
    exactIssueEvidence:
      '#799 owns the Pricing Permission model; these Core files add and prove the module scope consumed by the generated Pricing Permission declarations.',
    executionStatusEvidence: ISSUE_799_EXECUTION_STATUS_EVIDENCE,
    hitlRequired: false,
    id: 'core-module-permission-support',
    issues: ['#799'],
    owner: 'core-runtime',
    paths: [
      'app/packages/core-runtime/src/permissions/business-permission.ts',
      'app/packages/core-runtime/tests/unit/business-permission.test.ts',
    ],
    reason:
      'Extends the shared Permission schema with an explicit module scope so Pricing read Permissions remain atomic without inventing a business Resource target.',
    requiredByNowPricingLeaves: ['#799'],
  },
  {
    approvalOrPrEvidence:
      'Repository guidance requires supported Permission artifacts to start with Codesmith; #799 therefore requires the repository-owned generator to emit the module-scoped Pricing declarations.',
    disposition: 'keep',
    exactIssueEvidence:
      '#799 owns the generated Pricing Permission declarations; these infrastructure files add and test the generator input needed for their module scope.',
    executionStatusEvidence: ISSUE_799_EXECUTION_STATUS_EVIDENCE,
    hitlRequired: false,
    id: 'permission-generator-module-scope',
    issues: ['#799'],
    owner: 'infrastructure',
    paths: [
      'app/scripts/scaffolding/cli.mts',
      'app/scripts/scaffolding/permission/scaffold.mts',
      'app/scripts/scaffolding/shared.mts',
      'app/scripts/scaffolding/tests/permission-generator.test.mts',
    ],
    reason:
      'Adds the governed module-scope option required to generate the #799 Pricing Permissions and proves malformed or incompatible scopes still fail without partial writes.',
    requiredByNowPricingLeaves: ['#799'],
  },
  {
    approvalOrPrEvidence:
      'The HITL authorized completing the #738 review with the existing shared authorization infrastructure; this file records the regenerated inventory evidence rather than defining runtime policy.',
    disposition: 'keep',
    exactIssueEvidence:
      '#799 owns the atomic Pricing permissions whose generated inventory changes the checked-in authorization rollout baseline.',
    executionStatusEvidence: ISSUE_799_EXECUTION_STATUS_EVIDENCE,
    hitlRequired: false,
    id: 'pricing-authorization-rollout-evidence',
    issues: ['#799'],
    owner: 'infrastructure',
    paths: ['app/topology/authorization-rollout.json'],
    reason:
      'Keeps the source-controlled authorization inventory hash aligned with the generated Pricing permissions required by the active authorization leaf.',
    requiredByNowPricingLeaves: ['#799'],
  },
  {
    approvalOrPrEvidence:
      'Explicit HITL retention approval is recorded in the #738 scope-plan execution notes; no separate Catalog PR is recorded in the local #738 evidence.',
    disposition: 'keep',
    exactIssueEvidence:
      'The Catalog owner work is jointly governed by #452 quantity semantics, #476 public operations, and #479 purchase-decision evidence; shared registration and manifest paths support those public contracts.',
    executionStatusEvidence:
      '#452, #476, and #479 are open with exactly status:now in the live #738 scope review; the recorded HITL direction retains the existing owner-local implementation.',
    hitlRequired: false,
    id: 'catalog-owner-contracts',
    issues: ['#452', '#476', '#479'],
    owner: 'catalog',
    paths: [
      'app/verticals/catalog/api/index.ts',
      'app/verticals/catalog/api/pricing-purpose-equivalence-read-server.ts',
      'app/verticals/catalog/api/product-variant-snapshot-read-server.ts',
      'app/verticals/catalog/api/quantity-basis-compatibility-read-server.ts',
      'app/verticals/catalog/package.json',
      'app/verticals/catalog/shared/api.ts',
      'app/verticals/catalog/shared/apis/pricing-purpose-equivalence.ts',
      'app/verticals/catalog/shared/apis/product-variant-snapshot.ts',
      'app/verticals/catalog/shared/apis/quantity-basis-compatibility.ts',
      'app/verticals/catalog/shared/domain/catalog-quantity-handoff.ts',
      'app/verticals/catalog/src/api/catalog-client.ts',
      'app/verticals/catalog/src/api/pricing-purpose-equivalence-client.ts',
      'app/verticals/catalog/src/api/pricing-purpose-equivalence.read.ts',
      'app/verticals/catalog/src/api/product-variant-snapshot-client.ts',
      'app/verticals/catalog/src/api/product-variant-snapshot.read.ts',
      'app/verticals/catalog/src/api/quantity-basis-compatibility-client.ts',
      'app/verticals/catalog/src/api/quantity-basis-compatibility.read.ts',
      'app/verticals/catalog/src/api/selection-evidence.read.ts',
      'app/verticals/catalog/src/persistence/product-variant-snapshot-source.ts',
      'app/verticals/catalog/src/services/quantity-basis-compatibility.service.ts',
      'app/verticals/catalog/tests/unit/pricing-catalog-target-scope-acceptance.test.ts',
      'app/verticals/catalog/tests/unit/pricing-purpose-equivalence.test.ts',
      'app/verticals/catalog/tests/unit/product-variant-snapshot-read.test.ts',
      'app/verticals/catalog/tests/unit/public-operation-permission-matrix.test.ts',
      'app/verticals/catalog/tests/unit/quantity-basis-compatibility.test.ts',
      'app/verticals/catalog/tests/unit/selection-evidence-read.test.ts',
      'app/verticals/catalog/vertical.manifest.ts',
      'app/verticals/catalog/vertical.registration.ts',
    ],
    reason:
      'Catalog-owned target, purpose-equivalence, Variant snapshot, and quantity-basis evidence is consumed by exact-target, quantity, and owner-evidence NOW Pricing leaves.',
    requiredByNowPricingLeaves: ['#752', '#757', '#769', '#786'],
  },
  {
    approvalOrPrEvidence:
      'Explicit HITL retention approval is recorded in the #738 scope-plan execution notes; no separate Customer Context PR is recorded in the local #738 evidence.',
    disposition: 'keep',
    exactIssueEvidence: 'The local #738 traceability map assigns the Customer Context owner work to #333.',
    executionStatusEvidence:
      '#333 is closed with historical status:now; the recorded HITL scope decision retains this existing owner code without treating the closed issue as executable.',
    hitlRequired: false,
    id: 'customer-context-owner-contracts',
    issues: ['#333'],
    owner: COMMERCE_CUSTOMER_CONTEXT_OWNER,
    paths: [
      'app/verticals/commerce-customer-context/api/commerce-customer-context-production-layers.ts',
      'app/verticals/commerce-customer-context/api/index.ts',
      'app/verticals/commerce-customer-context/api/pricing-purchase-context-verification-read-server.ts',
      'app/verticals/commerce-customer-context/package.json',
      'app/verticals/commerce-customer-context/shared/api.ts',
      'app/verticals/commerce-customer-context/shared/apis/customer-price-group-resolution.ts',
      'app/verticals/commerce-customer-context/shared/apis/pricing-purchase-context-verification.ts',
      'app/verticals/commerce-customer-context/shared/apis/purchase-currency-resolution-domain-unavailable-problem.ts',
      'app/verticals/commerce-customer-context/shared/domain/purchase-currency-dependency.ts',
      'app/verticals/commerce-customer-context/shared/domain/purchase-currency-pricing-port.ts',
      'app/verticals/commerce-customer-context/shared/domain/purchase-currency-resolution.ts',
      'app/verticals/commerce-customer-context/src/api/customer-price-group-assignment-read.read.ts',
      'app/verticals/commerce-customer-context/src/api/customer-price-group-resolution.read.ts',
      'app/verticals/commerce-customer-context/src/api/pricing-purchase-context-verification-client.ts',
      'app/verticals/commerce-customer-context/src/api/pricing-purchase-context-verification.read.ts',
      'app/verticals/commerce-customer-context/src/api/purchase-currency-resolution.read.ts',
      'app/verticals/commerce-customer-context/src/integrations/purchase-currency-pricing.ts',
      'app/verticals/commerce-customer-context/src/services/pricing-purchase-context-owner-authority.ts',
      'app/verticals/commerce-customer-context/tests/unit/catalog-quantity-adapter.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/currency-support-evidence-issue-786-acceptance.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/currency.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/issue-333-composed-acceptance.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/price-group-resolution.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/pricing-purchase-context-owner-authority.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/purchase-currency-pricing-adapter.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/purchase-currency-pricing-runtime-proof.test.ts',
      'app/verticals/commerce-customer-context/tests/unit/tenant-currency-support-context-invariance-acceptance.test.ts',
      'app/verticals/commerce-customer-context/vertical.manifest.ts',
      'app/verticals/commerce-customer-context/vertical.registration.ts',
    ],
    reason:
      'Customer Context owns Profile/Guest purchasing context, Price Group resolution, and purchase-currency evidence required by the named NOW Pricing leaves.',
    requiredByNowPricingLeaves: ['#753', '#759', '#761', '#786', '#790'],
  },
  {
    approvalOrPrEvidence:
      'Explicit HITL retention approval is recorded in the #738 scope-plan execution notes; no separate Commerce Market PR is recorded in the local #738 evidence.',
    disposition: 'keep',
    exactIssueEvidence: 'The local #738 traceability map assigns the Commerce Market owner work to #346.',
    executionStatusEvidence:
      '#346 is closed with historical status:now; the recorded HITL scope decision retains this existing owner code without treating the closed issue as executable.',
    hitlRequired: false,
    id: 'market-owner-contracts',
    issues: ['#346'],
    owner: COMMERCE_MARKET_CATALOG_OWNER,
    paths: [
      'app/verticals/commerce-market-catalog/api/index.ts',
      'app/verticals/commerce-market-catalog/api/pricing-current-market-evidence-read-server.ts',
      'app/verticals/commerce-market-catalog/drizzle/20260928133500_pricing_current_market_evidence/migration.sql',
      'app/verticals/commerce-market-catalog/package.json',
      'app/verticals/commerce-market-catalog/scripts/verify-db-schema.mts',
      'app/verticals/commerce-market-catalog/shared/api.ts',
      'app/verticals/commerce-market-catalog/shared/apis/pricing-current-market-evidence.ts',
      'app/verticals/commerce-market-catalog/src/api/commerce-market-catalog-client.ts',
      'app/verticals/commerce-market-catalog/src/api/pricing-current-market-evidence-client.ts',
      'app/verticals/commerce-market-catalog/src/api/pricing-current-market-evidence.read.ts',
      'app/verticals/commerce-market-catalog/src/persistence/pricing-current-market-evidence-persistence.ts',
      'app/verticals/commerce-market-catalog/src/services/pricing-current-market-evidence.service.ts',
      'app/verticals/commerce-market-catalog/tests/integration/market-administration-postgres.test.ts',
      'app/verticals/commerce-market-catalog/tests/unit/database-schema-contract.test.ts',
      'app/verticals/commerce-market-catalog/tests/unit/market-public-contracts.test.ts',
      'app/verticals/commerce-market-catalog/tests/unit/pricing-current-market-evidence.test.ts',
      'app/verticals/commerce-market-catalog/vertical.manifest.ts',
      'app/verticals/commerce-market-catalog/vertical.registration.ts',
    ],
    reason:
      'Commerce Market Catalog owns current Market evidence and owner-local storage/runtime proof required by commercial-scope and external-owner-evidence NOW Pricing leaves.',
    requiredByNowPricingLeaves: ['#758', '#786'],
  },
  {
    approvalOrPrEvidence:
      'No Promotion-owner approval or separate PR for this package location is recorded locally; the #738 remediation rehomed the contract into pricing-contracts and removed the package plus its root TS reference.',
    disposition: 'remove',
    exactIssueEvidence:
      '#775 owns the NOW Pricing composition seam; #894 is only the PARK boundary for the non-positive-basis Promotion decision.',
    executionStatusEvidence: '#775 is status:now and #894 is status:park in the supplied #738 review.',
    hitlRequired: false,
    id: 'unapproved-promotion-contract-package',
    issues: ['#775', '#894'],
    owner: 'promotion',
    paths: [
      'app/packages/promotion-contracts/package.json',
      'app/packages/promotion-contracts/rstest.config.ts',
      'app/packages/promotion-contracts/src/contribution.ts',
      'app/packages/promotion-contracts/src/index.ts',
      'app/packages/promotion-contracts/tests/unit/promotion-contribution-issue-775-acceptance.test.ts',
      'app/packages/promotion-contracts/tests/unit/promotion-contribution.test.ts',
      'app/packages/promotion-contracts/tsconfig.json',
    ],
    reason:
      'The reviewed head added an unapproved cross-owner package for #775; the accepted remediation keeps the NOW contract but removes that package location and its workspace reference without activating PARK #894.',
    requiredByNowPricingLeaves: ['#775'],
  },
  {
    approvalOrPrEvidence:
      'No separate PR is recorded locally; the root TypeScript reference was removed with the unapproved Promotion package under the accepted #738 remediation.',
    disposition: 'remove',
    exactIssueEvidence:
      'The reviewed root TypeScript edit existed only to register the #775 Promotion contract package.',
    executionStatusEvidence: '#775 is status:now in the supplied #738 review.',
    hitlRequired: false,
    id: 'removed-promotion-workspace-reference',
    issues: ['#775'],
    owner: PRICING_WORKSPACE_OWNER,
    paths: ['app/tsconfig.json'],
    reason:
      'The reviewed head added the unapproved Promotion package to the workspace TypeScript graph; removal follows the accepted rehome into pricing-contracts.',
    requiredByNowPricingLeaves: ['#775'],
  },
] as const satisfies readonly Issue738NonPricingDispositionGroup[];

/** One machine-reviewable row per non-Pricing path in the reviewed baseline or live worktree diff. */
export const ISSUE_738_NON_PRICING_SCOPE_LEDGER = ISSUE_738_NON_PRICING_DISPOSITIONS.flatMap(
  ({ id, paths, ...evidence }) => paths.map((path) => ({ ...evidence, groupId: id, path })),
) satisfies readonly Issue738NonPricingScopeLedgerRow[];

export const ISSUE_738_ACTIVE_PRICING_LEAVES = [
  751, 752, 753, 754, 755, 756, 757, 758, 759, 760, 761, 762, 763, 764, 765, 766, 767, 768, 769, 770, 771, 772, 773,
  774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790, 791, 792, 793, 795, 797, 799,
  800, 802, 803, 805, 807, 890,
] as const;

export type Issue738ActivePricingLeaf = (typeof ISSUE_738_ACTIVE_PRICING_LEAVES)[number];
export type Issue738AuthorizedOwnerIssue = 333 | 346 | 452 | 476 | 479;
export type Issue738DeferredBoundaryIssue =
  | 891
  | 892
  | 893
  | 894
  | 895
  | 896
  | 897
  | 898
  | 899
  | 900
  | 901
  | 902
  | 903
  | 904
  | 905;

export type Issue738ProjectPath = `app/${string}`;
type NonEmptyPaths = readonly [Issue738ProjectPath, ...Issue738ProjectPath[]];
const DEFERRED_CONFIRMATION_PRODUCTION_PUBLICATION = {
  disposition: 'intentionally-unpublished',
  issue: 902,
  status: 'park',
} as const;

type TraceabilityRowBase = Readonly<{
  deferredProductionPublication?: typeof DEFERRED_CONFIRMATION_PRODUCTION_PUBLICATION;
  id: string;
  owner: Issue738TraceabilityOwner;
  productionRefs: NonEmptyPaths;
  tests: NonEmptyPaths;
}>;

export type Issue738ImplementationTraceabilityRow = TraceabilityRowBase &
  Readonly<{
    boundaryIssue?: never;
    issue: Issue738ActivePricingLeaf | Issue738AuthorizedOwnerIssue;
    proofClassification:
      | 'implementation-proof'
      | 'owner-acceptance'
      | 'owner-contract-integration'
      | 'owner-service-contract';
  }>;

export type Issue738BoundaryTraceabilityRow = TraceabilityRowBase &
  Readonly<{
    boundaryIssue: Issue738DeferredBoundaryIssue;
    issue: Issue738ActivePricingLeaf;
    proofClassification: 'contract-only' | 'deferred-boundary' | 'fixture-only';
  }>;

export type Issue738LeafTraceabilityRow = Issue738BoundaryTraceabilityRow | Issue738ImplementationTraceabilityRow;

const IMPLEMENTATION_PROOF_CLASSIFICATION = 'implementation-proof' as const;
const OWNER_CONTRACT_INTEGRATION_CLASSIFICATION = 'owner-contract-integration' as const;

const pricingImplementationRow = <const Issue extends Issue738ActivePricingLeaf>(
  id: string,
  issue: Issue,
  productionRef: Issue738ProjectPath,
  test: Issue738ProjectPath,
): Issue738ImplementationTraceabilityRow => ({
  id,
  issue,
  owner: 'pricing',
  productionRefs: [productionRef],
  proofClassification: issue === 890 ? 'owner-acceptance' : IMPLEMENTATION_PROOF_CLASSIFICATION,
  tests: [test],
});

/**
 * Roadmap authority for this evidence map. The superseding comment is authoritative over the
 * original issue body; the map records proof already present in this branch and does not activate
 * a deferred owner.
 */
export const issue738RoadmapAuthority = {
  issue: 253,
  supersedingComment: 'https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584',
} as const;

/**
 * Representative, executable traceability for the still-active Pricing leaves and the approved
 * owner contracts consumed by this branch. An implementation row proves a concrete code/test
 * link; it is not by itself a claim that every acceptance rule for that issue is complete.
 */
export const issue738LeafTraceability = [
  pricingImplementationRow(
    'pricing-751-canonical-decision',
    751,
    'app/packages/pricing-contracts/src/domain/pricing-decision.ts',
    'app/packages/pricing-contracts/tests/unit/pricing-decision.test.ts',
  ),
  pricingImplementationRow(
    'pricing-752-catalog-selection-and-quantity',
    752,
    'app/packages/pricing-contracts/src/domain/catalog-price-target.ts',
    'app/packages/pricing-contracts/tests/unit/catalog-price-target-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-754-typed-outcome-vocabulary',
    754,
    'app/packages/pricing-contracts/src/domain/exact-price-resolution.ts',
    'app/packages/pricing-contracts/tests/unit/exact-price-lookup.test.ts',
  ),
  pricingImplementationRow(
    'pricing-755-price-facts',
    755,
    'app/packages/pricing-contracts/src/domain/price-definition.ts',
    'app/packages/pricing-contracts/tests/unit/price-definition.test.ts',
  ),
  pricingImplementationRow(
    'pricing-756-price-schedules',
    756,
    'app/packages/pricing-contracts/src/domain/price-schedule.ts',
    'app/packages/pricing-contracts/tests/unit/price-schedule.test.ts',
  ),
  pricingImplementationRow(
    'pricing-757-exact-catalog-targets',
    757,
    'app/verticals/pricing/src/services/product-price-bulk.service.ts',
    'app/verticals/pricing/tests/unit/product-price-bulk.test.ts',
  ),
  pricingImplementationRow(
    'pricing-758-commercial-scope',
    758,
    'app/packages/pricing-contracts/src/domain/pricing-commercial-scope.ts',
    'app/packages/pricing-contracts/tests/unit/commercial-context-scope-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-760-source-provenance',
    760,
    'app/verticals/pricing/src/services/price-source-provenance.service.ts',
    'app/packages/pricing-contracts/tests/unit/price-source-provenance-issue-760-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-761-price-group-interpretation',
    761,
    'app/verticals/pricing/src/services/price-group-interpretation.service.ts',
    'app/verticals/pricing/tests/unit/price-group-interpretation-issue-761-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-762-price-group-fallback',
    762,
    'app/verticals/pricing/src/services/price-group-fallback.service.ts',
    'app/verticals/pricing/tests/unit/price-group-fallback-issue-762-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-763-exact-current-price',
    763,
    'app/verticals/pricing/src/services/exact-price-resolution.service.ts',
    'app/verticals/pricing/tests/unit/exact-price-resolution-issue-763-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-764-price-conflicts',
    764,
    'app/verticals/pricing/src/services/exact-price-conflict.service.ts',
    'app/verticals/pricing/tests/unit/price-conflicts-issue-764-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-765-broken-explicit-input',
    765,
    'app/verticals/pricing/src/services/broken-explicit-input.service.ts',
    'app/verticals/pricing/tests/unit/broken-explicit-input-http-issue-765-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-766-quantity-tier-definition',
    766,
    'app/verticals/pricing/src/services/quantity-tier-persistence.service.ts',
    'app/verticals/pricing/tests/unit/quantity-tier-definition-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-767-quantity-tier-selection',
    767,
    'app/verticals/pricing/src/services/quantity-tier-selection.service.ts',
    'app/verticals/pricing/tests/unit/quantity-tier-threshold-selection-issue-767-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-768-quantity-tier-aggregation',
    768,
    'app/verticals/pricing/src/services/quantity-tier-aggregation.service.ts',
    'app/verticals/pricing/tests/unit/quantity-tier-aggregation-issue-768-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-769-quantity-unit-package-basis',
    769,
    'app/verticals/pricing/src/services/quantity-unit-package-basis.service.ts',
    'app/verticals/pricing/tests/unit/quantity-unit-package-basis-issue-769-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-770-discount-families',
    770,
    'app/packages/pricing-contracts/src/domain/discount.ts',
    'app/packages/pricing-contracts/tests/unit/pricing-owned-discount-types-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-771-discount-applicability',
    771,
    'app/verticals/pricing/src/services/discount-applicability.service.ts',
    'app/verticals/pricing/tests/unit/discount-applicability-issue-771-runtime-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-772-discount-composition',
    772,
    'app/verticals/pricing/src/services/discount-composition.service.ts',
    'app/verticals/pricing/tests/unit/discount-composition-issue-772-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-773-commercial-fees',
    773,
    'app/verticals/pricing/src/services/commercial-fee-calculation.service.ts',
    'app/verticals/pricing/tests/unit/commercial-fee-calculation-issue-773-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-774-whole-purchase-allocation',
    774,
    'app/verticals/pricing/src/services/discount-fee-allocation.service.ts',
    'app/verticals/pricing/tests/unit/discount-fee-allocation-issue-774-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-775-promotion-contribution',
    775,
    'app/verticals/pricing/src/services/promotion-contribution-composition.service.ts',
    'app/verticals/pricing/tests/unit/promotion-contribution-issue-775-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-776-promotion-composition',
    776,
    'app/verticals/pricing/src/services/promotion-current-evaluation.service.ts',
    'app/verticals/pricing/tests/unit/promotion-composition-issue-776-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-777-exact-decimal-profile',
    777,
    'app/verticals/pricing/src/services/exact-decimal-profile.service.ts',
    'app/verticals/pricing/tests/unit/exact-decimal-and-precision-issue-777-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-778-unit-price-calculation',
    778,
    'app/verticals/pricing/src/services/unit-price-calculation.service.ts',
    'app/verticals/pricing/tests/unit/unit-price-calculation-issue-778-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-779-line-value-composition',
    779,
    'app/verticals/pricing/src/services/line-value-composition.service.ts',
    'app/verticals/pricing/tests/unit/line-value-calculation-issue-779-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-780-commercial-totals',
    780,
    'app/verticals/pricing/src/services/commercial-totals.service.ts',
    'app/verticals/pricing/tests/unit/commercial-totals-issue-780-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-781-rounding-boundary',
    781,
    'app/verticals/pricing/src/services/line-value-publication.service.ts',
    'app/verticals/pricing/tests/unit/rounding-boundaries-issue-781-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-782-current-versus-quotation',
    782,
    'app/verticals/pricing/src/services/pricing-authority-selection.service.ts',
    'app/verticals/pricing/tests/unit/current-decision-vs-quotation-issue-782-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-783-quotation-scope',
    783,
    'app/verticals/pricing/src/services/quotation-scope-verification.service.ts',
    'app/verticals/pricing/tests/unit/quotation-scope-issue-783-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-784-quotation-validity',
    784,
    'app/verticals/pricing/src/services/quotation-validity.service.ts',
    'app/verticals/pricing/tests/unit/quotation-validity-issue-784-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-785-quotation-revalidation',
    785,
    'app/verticals/pricing/src/services/quotation-revalidation.service.ts',
    'app/verticals/pricing/tests/unit/quotation-revalidation-issue-785-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-786-material-evidence',
    786,
    'app/verticals/pricing/src/services/material-evidence-assembly.service.ts',
    'app/verticals/pricing/tests/unit/material-evidence-issue-786-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-787-material-change-and-retry',
    787,
    'app/verticals/pricing/src/services/scheduled-material-state-detection.service.ts',
    'app/verticals/pricing/tests/unit/material-change-schedule-issue-787-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-789-accepted-handoff',
    789,
    'app/verticals/pricing/src/services/accepted-order-handoff-serializer.service.ts',
    'app/verticals/pricing/tests/unit/pricing-accepted-order-handoff-issue-789-acceptance.test.ts',
  ),
  pricingImplementationRow(
    'pricing-791-pricing-result-contract',
    791,
    'app/packages/pricing-contracts/src/apis/current-pricing-decision.ts',
    'app/packages/pricing-contracts/tests/unit/current-pricing-decision.test.ts',
  ),
  pricingImplementationRow(
    'pricing-792-purchasing-limits-boundary',
    792,
    'app/packages/pricing-contracts/src/domain/pricing-owner-handoff.ts',
    'app/packages/pricing-contracts/tests/unit/pricing-owner-handoff.test.ts',
  ),
  pricingImplementationRow(
    'pricing-793-tax-boundary',
    793,
    'app/packages/pricing-contracts/src/domain/pricing-owner-handoff.ts',
    'app/packages/pricing-contracts/tests/unit/pricing-owner-handoff.test.ts',
  ),
  pricingImplementationRow(
    'pricing-795-price-reconfirmation',
    795,
    'app/packages/pricing-contracts/src/domain/price-reconfirmation.ts',
    'app/packages/pricing-contracts/tests/unit/price-reconfirmation.test.ts',
  ),
  {
    id: 'pricing-753-purchasing-context',
    issue: 753,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/integrations/commercial-context-evidence.ts',
      'app/verticals/pricing/src/services/current-pricing-decision-subject-authority.service.ts',
    ],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/commercial-context-evidence.test.ts',
      'app/verticals/pricing/tests/unit/customer-context-subject-authority.test.ts',
    ],
  },
  {
    id: 'pricing-759-currency-support',
    issue: 759,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/persistence/currency-support-persistence.ts',
      'app/verticals/pricing/api/current-supported-currencies-read-server.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/tenant-currency-support-management-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/tenant-currency-support-read-acceptance.test.ts',
    ],
  },
  {
    deferredProductionPublication: DEFERRED_CONFIRMATION_PRODUCTION_PUBLICATION,
    id: 'pricing-788-confirmation',
    issue: 788,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/services/current-backed-confirmation-issuance.service.ts',
      'app/verticals/pricing/src/services/quotation-backed-confirmation-issuance.service.ts',
      'app/verticals/pricing/src/services/commitment-confirmation-renewal.service.ts',
    ],
    proofClassification: 'owner-service-contract',
    tests: [
      'app/verticals/pricing/tests/unit/current-backed-confirmation-issuance-service.test.ts',
      'app/verticals/pricing/tests/unit/quotation-backed-confirmation-issuance-service.test.ts',
      'app/verticals/pricing/tests/unit/commitment-confirmation-renewal-issue-788.test.ts',
      'app/verticals/pricing/tests/unit/commitment-confirmation-publication-boundary.test.ts',
    ],
  },
  {
    id: 'pricing-790-current-decision',
    issue: 790,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/services/current-pricing-decision-whole-evaluation.service.ts',
      'app/verticals/pricing/api/current-pricing-decision-read-server.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/pricing-current-decision-read-issue-790-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/current-pricing-decision-owner-final-fence-issue-790.test.ts',
    ],
  },
  {
    id: 'pricing-797-management-actions',
    issue: 797,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/actions/define-price.action.ts',
      'app/verticals/pricing/src/actions/manage-product-prices-bulk.action.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/pricing-price-management-actions-issue-797-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/product-price-bulk-management-acceptance.test.ts',
    ],
  },
  {
    id: 'pricing-799-permission-model',
    issue: 799,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/shared/apis/current-pricing-decision.ts',
      'app/verticals/pricing/shared/apis/current-supported-currencies.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/current-pricing-decision-read.test.ts',
      'app/verticals/pricing/tests/unit/pricing-management-http-contract.test.ts',
    ],
  },
  {
    deferredProductionPublication: DEFERRED_CONFIRMATION_PRODUCTION_PUBLICATION,
    id: 'pricing-800-audit-and-visibility',
    issue: 800,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/actions/manage-commitment-confirmation.action.ts',
      'app/verticals/pricing/src/services/commitment-confirmation-persistence.service.ts',
      'app/verticals/pricing/src/actions/set-supported-currencies.action.ts',
      'app/verticals/pricing/src/services/source-evidence-projection.service.ts',
      'app/verticals/pricing/drizzle/20260928103000_pricing_commitment_confirmations_v1/migration.sql',
    ],
    proofClassification: 'owner-service-contract',
    tests: [
      'app/verticals/pricing/tests/unit/manage-commitment-confirmation-action-issue-800.test.ts',
      'app/verticals/pricing/tests/unit/commitment-confirmation-database-contract.test.ts',
      'app/verticals/pricing/tests/unit/commitment-confirmation-publication-boundary.test.ts',
      'app/verticals/pricing/tests/unit/set-supported-currencies.test.ts',
      'app/verticals/pricing/tests/unit/source-evidence-projection-service.test.ts',
    ],
  },
  {
    id: 'pricing-802-idempotency-and-conflict',
    issue: 802,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/services/price-persistence.service.ts',
      'app/verticals/pricing/src/services/product-price-bulk.service.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/price-management-actions-acceptance.test.ts',
      'app/verticals/pricing/tests/unit/price-result-lookup-issue-797.test.ts',
    ],
  },
  {
    id: 'pricing-803-source-authority',
    issue: 803,
    owner: 'pricing',
    productionRefs: [
      'app/verticals/pricing/src/services/pricing-authority-selection.service.ts',
      'app/verticals/pricing/src/services/price-source-provenance.service.ts',
    ],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: [
      'app/verticals/pricing/tests/unit/pricing-authority-selection-service.test.ts',
      'app/verticals/pricing/tests/unit/price-source-provenance-service.test.ts',
    ],
  },
  {
    id: 'pricing-805-external-price-input',
    issue: 805,
    owner: 'pricing',
    productionRefs: ['app/verticals/pricing/src/services/external-price-input-boundary.service.ts'],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: ['app/verticals/pricing/tests/unit/external-price-input-boundary-issues-803-805.test.ts'],
  },
  {
    id: 'pricing-807-recovery',
    issue: 807,
    owner: 'pricing',
    productionRefs: ['app/verticals/pricing/src/services/currency-support-recovery.service.ts'],
    proofClassification: IMPLEMENTATION_PROOF_CLASSIFICATION,
    tests: ['app/verticals/pricing/tests/unit/currency-support-recovery-issue-807.test.ts'],
  },
  {
    id: 'pricing-890-owner-acceptance',
    issue: 890,
    owner: 'pricing',
    productionRefs: ['app/verticals/pricing/vertical.manifest.ts'],
    proofClassification: 'owner-acceptance',
    tests: ['app/verticals/pricing/tests/unit/pricing-owner-contract-issue-890-acceptance.test.ts'],
  },
  {
    id: 'catalog-452-quantity-basis',
    issue: 452,
    owner: 'catalog',
    productionRefs: [
      'app/verticals/catalog/shared/apis/quantity-basis-compatibility.ts',
      'app/verticals/catalog/src/services/quantity-basis-compatibility.service.ts',
    ],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: [
      'app/verticals/catalog/tests/unit/quantity-basis-compatibility.test.ts',
      'app/verticals/catalog/tests/unit/catalog-quantity-handoff-seam.test.ts',
    ],
  },
  {
    id: 'catalog-476-public-reads',
    issue: 476,
    owner: 'catalog',
    productionRefs: ['app/verticals/catalog/shared/api.ts'],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: ['app/verticals/catalog/tests/unit/public-operation-permission-matrix.test.ts'],
  },
  {
    id: 'catalog-479-purchase-evidence',
    issue: 479,
    owner: 'catalog',
    productionRefs: [
      'app/verticals/catalog/shared/apis/product-variant-snapshot.ts',
      'app/verticals/catalog/shared/apis/pricing-purpose-equivalence.ts',
    ],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: [
      'app/verticals/catalog/tests/unit/product-variant-snapshot-read.test.ts',
      'app/verticals/catalog/tests/unit/pricing-purpose-equivalence.test.ts',
    ],
  },
  {
    id: 'customer-context-333-purchase-policy',
    issue: 333,
    owner: COMMERCE_CUSTOMER_CONTEXT_OWNER,
    productionRefs: [
      'app/verticals/commerce-customer-context/shared/apis/pricing-purchase-context-verification.ts',
      'app/verticals/commerce-customer-context/src/services/pricing-purchase-context-owner-authority.ts',
    ],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: ['app/verticals/commerce-customer-context/tests/unit/pricing-purchase-context-owner-authority.test.ts'],
  },
  {
    id: 'market-346-current-market-evidence',
    issue: 346,
    owner: COMMERCE_MARKET_CATALOG_OWNER,
    productionRefs: [
      'app/verticals/commerce-market-catalog/shared/apis/pricing-current-market-evidence.ts',
      'app/verticals/commerce-market-catalog/src/services/pricing-current-market-evidence.service.ts',
    ],
    proofClassification: OWNER_CONTRACT_INTEGRATION_CLASSIFICATION,
    tests: ['app/verticals/commerce-market-catalog/tests/unit/pricing-current-market-evidence.test.ts'],
  },
  {
    boundaryIssue: 894,
    id: 'pricing-775-promotion-contract-only',
    issue: 775,
    owner: 'pricing',
    productionRefs: ['app/packages/pricing-contracts/src/domain/promotion-contribution.ts'],
    proofClassification: 'contract-only',
    tests: ['app/packages/pricing-contracts/tests/unit/promotion-contribution.test.ts'],
  },
  {
    boundaryIssue: 894,
    id: 'pricing-775-promotion-fixture-only',
    issue: 775,
    owner: 'pricing',
    productionRefs: ['app/verticals/pricing/src/services/promotion-contribution-composition.service.ts'],
    proofClassification: 'fixture-only',
    tests: ['app/verticals/pricing/tests/unit/promotion-contribution-composition-service.test.ts'],
  },
  {
    boundaryIssue: 894,
    id: 'pricing-775-promotion-deferred-boundary',
    issue: 775,
    owner: 'pricing',
    productionRefs: ['app/verticals/pricing/src/integrations/promotion-module-not-installed-final-fence.ts'],
    proofClassification: 'deferred-boundary',
    tests: ['app/verticals/pricing/tests/unit/promotion-module-not-installed-final-fence.test.ts'],
  },
] as const satisfies readonly Issue738LeafTraceabilityRow[];
