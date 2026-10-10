import { Schema } from 'effect';

import type { TAX_FOREIGN_OWNER_DOUBLES } from './tax-evaluation-fixtures.ts';

/**
 * D6 acceptance ledger for #961-#963 (Unit 13). Each row maps coverage keys of one issue to the named tests CI runs, or
 * says why nothing is executed. There is no "passed" field: passing is CI's job, and a gated row is never reported as
 * passed (#963 G). The ledger test checks that every key is covered, every named test exists verbatim, and the D6
 * rules hold.
 */

type NonEmpty<Value> = readonly [Value, ...Value[]];
type AcceptanceIssue = 961 | 962 | 963;
type ForeignDouble = keyof typeof TAX_FOREIGN_OWNER_DOUBLES;
type TestFile = `app/verticals/tax/tests/${'integration' | 'unit'}/${string}.test.ts`;
export type TestRef = Readonly<{ file: TestFile; title: string }>;
/** Foreign owners whose part of a scenario no test executes. */
const GatedOwnerSchema = Schema.Literals([
  'APPROVAL',
  'BILLING',
  'CATALOG',
  'COMMERCE',
  'DELIVERY',
  'INVENTORY',
  'ORDER',
  'PRICING',
  'PRIVACY',
  'PROMOTION',
]);
type GatedOwner = typeof GatedOwnerSchema.Type;

type Evidence =
  /** Real TAX over Postgres; the seller regime is declared through the real service. */
  | Readonly<{ doubles: readonly ForeignDouble[]; kind: 'OWNER_PERSISTED'; tests: NonEmpty<TestRef> }>
  /** Real TAX domain code; TAX own state may be injected. */
  | Readonly<{ doubles: readonly ForeignDouble[]; kind: 'OWNER_KERNEL'; tests: NonEmpty<TestRef> }>
  /** A foreign owner's part that no test executes; never "passed". */
  | Readonly<{ kind: 'GATED_NOT_EXECUTED'; owner: GatedOwner; ownerIssue: number; reason: string }>
  /** Issue text patched by the PO-approved OWNERSHIP-FINAL / Unit 12 decisions; the replacement rows carry the proof. */
  | Readonly<{
      kind: 'SUPERSEDED';
      patch: 'OWNERSHIP-FINAL §3' | 'OWNERSHIP-FINAL §7' | 'UNIT12 H10';
      replacedBy: NonEmpty<string>;
    }>
  /** Nothing exists to exercise; the guard test fails if that changes. */
  | Readonly<{ guard: TestRef; kind: 'NOT_APPLICABLE'; reason: string }>;

export type TaxAcceptanceRow = Readonly<{
  evidence: Evidence;
  id: string;
  issue: AcceptanceIssue;
  keys: NonEmpty<string>;
}>;

/** #961 H10, #963 G: a green suite is TAX owner acceptance only, never Commerce E2E or production activation. */
export const TAX_ACCEPTANCE_CLAIM = 'TAX_OWNER_ACCEPTANCE_ONLY' as const;

/** Keys shared by several rows or issues. */
const BDD_PRICING_PARKED = 'BDD-pricing-parked';
const PO_BUNDLE_CONTENT = 'PO-bundle-content';
const G_WHOLE_SET = 'G-whole-set';
const G_INCOMPLETE = 'G-incomplete';
const G_TAXABLE_ZERO = 'G-taxable-zero';
const G_PRICING_PARK = 'G-pricing-park';
const G_PROMOTION = 'G-promotion';
const BDD_COMPETING_CORRECTION = 'BDD-competing-correction';

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);
const sectionKeys = (counts: readonly number[]) => counts.flatMap((count, index) => range(`§${index + 1}.`, 1, count));

/** Closed key lists: the H criteria, BDD scenarios, PO additions, G cases and patched F rules of each issue. */
export const TAX_ACCEPTANCE_KEYS = {
  961: [
    ...range('H', 1, 10),
    'BDD-success',
    'BDD-rule-absent',
    'BDD-incomplete',
    BDD_PRICING_PARKED,
    'BDD-fabricated-result',
    'BDD-history-R1',
    'PO-frozen-T',
    'PO-final-evidence',
    PO_BUNDLE_CONTENT,
    'PO-deterministic',
    'PO-fail-before-final',
    'PO-no-ttl',
    'G-b2c',
    'G-b2b',
    'G-equal-occurrences',
    G_WHOLE_SET,
    'G-one-match',
    'G-complete-empty',
    G_INCOMPLETE,
    'G-seller-prerequisite',
    'G-source-unavailable',
    G_TAXABLE_ZERO,
    'G-rule-change-after-accepted',
    G_PRICING_PARK,
    'G-external-route-park',
    'F5',
    'F25',
    'F41',
    'F55',
  ],
  962: [
    ...range('H', 1, 14),
    'BDD-midpoint',
    'BDD-two-units',
    'BDD-equal-rate',
    'BDD-discount',
    'BDD-fee',
    'BDD-mixed-rate-shipping',
    'BDD-shipping-unavailable',
    'BDD-whole-set',
    'BDD-unsupported-set',
    'BDD-zero',
    'BDD-rule-missing',
    'BDD-half-open',
    'BDD-empty-observation',
    'PO-rational-1-6',
    'PO-unit-rounding',
    'PO-cumulative-partial',
    'PO-exhaustion-zero',
    'PO-no-cross-unit',
    'G-half-cent',
    'G-two-sub-cent',
    'G-equal-rate',
    'G-discount',
    G_PROMOTION,
    'G-fees',
    'G-shipping-one-rate',
    'G-shipping-mixed',
    'G-shipping-subset',
    'G-shipping-zero',
    'G-shipping-unavailable',
    G_WHOLE_SET,
    'G-unsupported-set',
    G_TAXABLE_ZERO,
    'G-effective-from',
    'G-effective-to',
    'G-rule-gap',
    G_INCOMPLETE,
    'G-overlap-conflict',
    'F47',
  ],
  963: [
    // The bullets of D in order: §1 6, §2 6, §3 6, §4 9, §5 4, §6 6, §7 7, §8 2.
    ...sectionKeys([6, 6, 6, 9, 4, 6, 7, 2]),
    'BDD-rule-changes-inside',
    'BDD-crosses-boundary',
    'BDD-lost-response',
    'BDD-ordinary-change',
    'BDD-customer-terms',
    'BDD-approval-compatibility',
    'BDD-governance-lost',
    'BDD-changed-masters',
    'BDD-full-cumulative',
    BDD_COMPETING_CORRECTION,
    'G-evidence-record',
    '§7.3-b2c-order-snapshot',
  ],
} satisfies Record<AcceptanceIssue, readonly string[]>;

const integration = (name: string, title: string): TestRef => ({
  file: `app/verticals/tax/tests/integration/${name}.test.ts`,
  title,
});
const unit = (name: string, title: string): TestRef => ({
  file: `app/verticals/tax/tests/unit/${name}.test.ts`,
  title,
});

const customerSafeTaxProjectionTest = (title: string) => unit('customer-safe-tax-projection', title);
const launchCoverageTest = (title: string) => unit('launch-coverage', title);
const moduleContractTest = (title: string) => unit('module-contract', title);
const shippingAllocationTest = (title: string) => unit('shipping-allocation', title);
const taxAcceptanceLedgerTest = (title: string) => unit('tax-acceptance-ledger', title);
const taxCorrectionDeltaTest = (title: string) => unit('tax-correction-delta', title);
const taxCorrectionPreviewTest = (title: string) => unit('tax-correction-preview', title);
const taxDecisionTest = (title: string) => unit('tax-decision', title);
const taxEvaluationTest = (title: string) => unit('tax-evaluation', title);
const taxEvaluationAttemptTest = (title: string) => unit('tax-evaluation-attempt', title);
const taxMaterialityTest = (title: string) => unit('tax-materiality', title);
const taxNonSuccessOutcomeTest = (title: string) => unit('tax-non-success-outcome', title);
const taxOutcomeTest = (title: string) => unit('tax-outcome', title);
const taxPrivacyOwnerContractTest = (title: string) => unit('tax-privacy-owner-contract', title);
const taxResultTest = (title: string) => unit('tax-result', title);
const taxRoundingTest = (title: string) => unit('tax-rounding', title);
const taxRuleSelectionTest = (title: string) => unit('tax-rule-selection', title);
const taxTimeTest = (title: string) => unit('tax-time', title);
const taxableBasisTest = (title: string) => unit('taxable-basis', title);
const taxableSupplyUnitTest = (title: string) => unit('taxable-supply-unit', title);
const evPg = (title: string) => integration('tax-evaluation-postgres', title);
const finPg = (title: string) => integration('order-tax-finalization-postgres', title);
const declPg = (title: string) => integration('seller-vat-regime-declaration-postgres', title);
const govPg = (title: string) => integration('tax-governance-persistence-postgres', title);
const privPg = (title: string) => integration('tax-privacy-coverage-postgres', title);
const corrHttp = (title: string) => integration('tax-correction-preview-http', title);

/** Guards of the NOT_APPLICABLE rows (Stage A and this ledger's own test). */
const NO_TTL_GUARD = moduleContractTest(
  '#961 PO #963 §4-5 the final Order Tax handoff carries no Tax TTL, expiry, renewal or proof',
);
const NO_OUTBOX_GUARD = moduleContractTest(
  '#963 §6 TAX publishes no Outbox message or domain event, so no delivery debt exists',
);
const NO_SELLER_ROUTE_GUARD = moduleContractTest(
  '#964 no external seller route: the Seller VAT Regime enters only through the governed declare Action',
);
const LEDGER_D6_GUARD = taxAcceptanceLedgerTest(
  '#961 F22 D6 rows are never kernel-only and name only foreign-owner doubles',
);
const LEDGER_GATED_GUARD = taxAcceptanceLedgerTest(
  '#963 G gated rows run no test, name a non-TAX owner issue and keep PARK issues out of executed rows',
);
const LEDGER_TITLES_GUARD = taxAcceptanceLedgerTest('every mapped test file exists and contains its title verbatim');

const SCENARIO_DOUBLES = ['catalogEntry', 'pricingLine', 'places', 'sellerPlace', 'purchaseBindingInput'] as const;

const persisted = (
  id: string,
  issue: AcceptanceIssue,
  keys: NonEmpty<string>,
  tests: NonEmpty<TestRef>,
  doubles: readonly ForeignDouble[] = SCENARIO_DOUBLES,
): TaxAcceptanceRow => ({ evidence: { doubles, kind: 'OWNER_PERSISTED', tests }, id, issue, keys });
const kernel = (
  id: string,
  issue: 962 | 963,
  keys: NonEmpty<string>,
  tests: NonEmpty<TestRef>,
  doubles: readonly ForeignDouble[] = [],
): TaxAcceptanceRow => ({ evidence: { doubles, kind: 'OWNER_KERNEL', tests }, id, issue, keys });
const gated = (
  id: string,
  issue: AcceptanceIssue,
  keys: NonEmpty<string>,
  owner: GatedOwner,
  ownerIssue: number,
  reason: string,
): TaxAcceptanceRow => ({ evidence: { kind: 'GATED_NOT_EXECUTED', owner, ownerIssue, reason }, id, issue, keys });
const superseded = (
  id: string,
  issue: AcceptanceIssue,
  keys: NonEmpty<string>,
  patch: 'OWNERSHIP-FINAL §3' | 'OWNERSHIP-FINAL §7' | 'UNIT12 H10',
  replacedBy: NonEmpty<string>,
): TaxAcceptanceRow => ({ evidence: { kind: 'SUPERSEDED', patch, replacedBy }, id, issue, keys });
const notApplicable = (
  id: string,
  issue: AcceptanceIssue,
  keys: NonEmpty<string>,
  guard: TestRef,
  reason: string,
): TaxAcceptanceRow => ({ evidence: { guard, kind: 'NOT_APPLICABLE', reason }, id, issue, keys });

const scenario = (number: number, title: string) => evPg(`#961 scenario ${number}: ${title}`);
const SCENARIO_1 = scenario(1, 'ordinary B2C for a declared VAT_PAYER seller through the public read handler');
const SCENARIO_2 = scenario(2, 'ordinary B2B with no buyer VAT status has the same success meaning as B2C');
const SCENARIO_3 = scenario(3, 'two equal-valued distinct occurrences at 21 % stay two units, each rounded separately');
const SCENARIO_4 = scenario(4, 'a supported whole-treatment Set is one Taxable Supply Unit with no component prices');
const SCENARIO_5 = scenario(5, 'a complete empty rule state for a supported case is TAX_RULE_MISSING, never 0 CZK');
const SCENARIO_6 = scenario(
  6,
  'an unavailable delivery destination is TAX_DEPENDENCY_UNAVAILABLE, never a CZ fallback',
);
const SCENARIO_7 = scenario(
  7,
  'a known non-CZ destination with rules present is TAX_CASE_UNSUPPORTED, no domestic fallback',
);
const SCENARIO_8 = scenario(8, 'a NON_PAYER seller succeeds as non-payer and an undeclared seller is indeterminate');
const SCENARIO_10 = scenario(10, 'a supported 0.00 CZK line is a successful taxable 0.00 with its persisted rule');
const SCENARIO_9 = finPg(
  '#961 scenario 9: the finalize Action and final read handlers persist, recover and hand off the final',
);

const INCOMPLETE_RULE_STATE = taxRuleSelectionTest(
  '#929 F17 #930 F7 #942 F12 F15 without complete owner state the outcome is TAX_STATE_INDETERMINATE, never missing',
);
const FINAL_AT_T = finPg('#944 F8-F13 #941 F2-F9 a final Order Tax is fixed at T, stored once and recovered unchanged');
const FINAL_CONCURRENT = finPg('#950 F24 #944 F11 finals are scoped, immutable and converge under concurrent requests');
const FINAL_CRASH_BEFORE_COMMIT = finPg(
  '#963 §3.3 a crash after the final insert and before commit leaves no final; the exact retry finalizes once at T',
);
const FINAL_NON_SUCCESS = finPg(
  '#944 F12 a non-success stores nothing; the same submission finalizes once rules exist',
);
const FINAL_RULES_AT_T = finPg('#941 F5 F10 the final selects rules at T, not at the later Tax Evaluation Time');
const FINAL_CORRECTION_NAMED = finPg(
  '#930 F11 F13 the final read names a later correction of a governing revision without refreshing it',
);
const FINAL_BACKDATED = finPg(
  'Unit 10 C a backdated regime revision recorded after a final leaves the recovered final unchanged',
);
const FINAL_DECLARE_RACE = finPg('Unit 10 C a declare concurrent with finalize serializes on the seller lock');
const CORRECTION_HISTORICAL_READ = taxCorrectionPreviewTest(
  '#947 F1-F3 #946 F21 a historical read is answered by the retained terms without any Tax evaluation',
);
const CUMULATIVE_PARTIAL = taxCorrectionDeltaTest(
  '#948 F17-F23 cumulative partial returns 3, 3, 4 of 10 x 99.99 CZK at 21 % exhaust to exactly 0.00 CZK',
);
const EXPECTED_STATE_ECHO = taxCorrectionDeltaTest(
  '#946 F16-F17 #948 F27 echoes the expected previous state version opaquely and consumes nothing',
);

const ledger961: readonly TaxAcceptanceRow[] = [
  persisted(
    'owner-public-contract',
    961,
    ['H1', 'H3', 'H6', 'H7', 'BDD-success', 'G-b2c', G_PRICING_PARK, BDD_PRICING_PARKED],
    [SCENARIO_1, SCENARIO_9],
  ),
  persisted('owner-b2b', 961, ['H1', 'G-b2b'], [SCENARIO_2]),
  persisted('owner-rounding-per-unit', 961, ['H4', 'G-equal-occurrences'], [SCENARIO_3]),
  persisted('owner-whole-set', 961, ['H3', G_WHOLE_SET], [SCENARIO_4]),
  persisted(
    'owner-rule-absent',
    961,
    ['H5', 'G-complete-empty', 'BDD-rule-absent', 'PO-fail-before-final'],
    [SCENARIO_5, FINAL_NON_SUCCESS, finPg('Unit 10 C a seller with nothing declared cannot finalize')],
  ),
  persisted('owner-source-unavailable', 961, ['H5', 'G-source-unavailable'], [SCENARIO_6, SCENARIO_7]),
  persisted(
    'owner-taxable-zero',
    961,
    [G_TAXABLE_ZERO],
    [
      SCENARIO_10,
      taxEvaluationTest(
        '#962 BDD zero a supported VAT_PAYER line of 0.00 CZK is a successful taxable 0.00, not zero-rate, exempt or non-payer',
      ),
    ],
  ),
  persisted(
    'owner-one-match',
    961,
    ['H2', 'G-one-match'],
    [evPg('#942 #936 #941 a VAT_PAYER seller publishes one rated Decision and Result from complete rule state')],
  ),
  persisted(
    'owner-incomplete',
    961,
    ['H5', G_INCOMPLETE, 'BDD-incomplete'],
    [
      evPg('#942 F12-F15 #938 a VAT_PAYER seller with incomplete or conflicting rule state keeps its typed meaning'),
      INCOMPLETE_RULE_STATE,
    ],
  ),
  persisted('owner-final-at-t', 961, ['PO-frozen-T', 'PO-final-evidence', PO_BUNDLE_CONTENT], [FINAL_AT_T, SCENARIO_9]),
  persisted('owner-deterministic', 961, ['PO-deterministic'], [FINAL_CONCURRENT]),
  persisted(
    'owner-history-r1',
    961,
    ['H8', 'BDD-history-R1', 'G-rule-change-after-accepted'],
    [FINAL_CORRECTION_NAMED, FINAL_BACKDATED],
  ),
  persisted(
    'seller-regime-real',
    961,
    ['H2'],
    [
      declPg('Unit 10 B the regime selected at an instant follows the timeline rule, scoped per tenant and seller'),
      evPg('Unit 10 C a regime revision effective after T but recorded before E still selects the regime at T'),
    ],
  ),
  superseded('authority-contract-interpretation', 961, ['F5'], 'OWNERSHIP-FINAL §7', ['seller-regime-real']),
  persisted(
    'nonpayer-success',
    961,
    ['H5'],
    [
      evPg('Unit 10 C a NON_PAYER seller publishes a zero-tax Decision with no rule read and the non-payer projection'),
      finPg('Unit 10 C a NON_PAYER final stores zero tax with no governing rule revisions'),
      SCENARIO_8,
    ],
  ),
  persisted(
    'not-declared-indeterminate',
    961,
    ['H5'],
    [evPg('Unit 10 C a seller with nothing declared is indeterminate, never a stored final meaning'), SCENARIO_8],
  ),
  superseded('seller-prerequisite-not-met', 961, ['G-seller-prerequisite', 'F41'], 'OWNERSHIP-FINAL §3', [
    'nonpayer-success',
    'not-declared-indeterminate',
  ]),
  notApplicable(
    'no-external-seller-route',
    961,
    ['H9'],
    NO_SELLER_ROUTE_GUARD,
    'Launch has no external seller route and pulls no PARK/LATER integration forward; the Seller VAT Regime enters only through the governed declare Action',
  ),
  superseded('external-route-park', 961, ['G-external-route-park', 'F25', 'F55'], 'OWNERSHIP-FINAL §7', [
    'no-external-seller-route',
  ]),
  notApplicable(
    'no-tax-ttl',
    961,
    ['PO-no-ttl'],
    NO_TTL_GUARD,
    'No Tax TTL, expiry, renewal or proof field exists to exercise',
  ),
  notApplicable(
    'no-fabricated-result',
    961,
    ['BDD-fabricated-result'],
    LEDGER_D6_GUARD,
    'A fixture-built Result cannot be #961 evidence: every #961 row is OWNER_PERSISTED, never kernel-only',
  ),
  notApplicable(
    'owner-acceptance-only',
    961,
    ['H10'],
    LEDGER_GATED_GUARD,
    'The claim is TAX_OWNER_ACCEPTANCE_ONLY; every downstream part is a gated row that runs no test',
  ),
  gated(
    'pricing-to-tax-e2e',
    961,
    [G_PRICING_PARK, BDD_PRICING_PARKED],
    'PRICING',
    892,
    '#892 is PARK: Pricing→Tax is not proven; TAX uses the labelled pricingLine double (#961 F24, F54)',
  ),
  gated(
    'catalog-to-tax-production',
    961,
    ['H6'],
    'CATALOG',
    253,
    'Catalog publishes no Tax-purpose contract (#961 F26b); no Catalog issue exists yet (OWNERSHIP §8 item 4), so the roadmap #253 is named. The catalogEntry double conforms to TAX’s consumer schema only',
  ),
  gated(
    'bundle-persistence',
    961,
    [PO_BUNDLE_CONTENT],
    'COMMERCE',
    330,
    '#330 is PARK: Bundle persistence is not executed; the TAX side is the decoded handoff in scenario 9',
  ),
  gated(
    'checkout-order-billing-e2e',
    961,
    ['H10'],
    'COMMERCE',
    329,
    '#329 is PARK: Checkout/Order/Billing E2E is not executed (#961 F53)',
  ),
];

const ledger962: readonly TaxAcceptanceRow[] = [
  kernel(
    'midpoint',
    962,
    ['H1', 'BDD-midpoint', 'G-half-cent'],
    [
      taxRoundingTest('#935 F21-F22 BDD rounds 10.004 / 10.005 / 10.006 HALF_UP to 0.01 CZK'),
      taxRoundingTest(
        'D3-2 LEGAL §2 tie 0.14 / 12 %: the exact GROSS VAT is 0.015, which rounds HALF_UP to 0.02, never 0.01',
      ),
    ],
  ),
  kernel(
    'two-sub-cent-units',
    962,
    ['H2', 'H3', 'H4', 'BDD-two-units', 'G-two-sub-cent', 'PO-unit-rounding'],
    [
      taxRoundingTest('#935 F27-F30 BDD two 0.0063 units publish 0.01 + 0.01 = 0.02, not ROUND(SUM) = 0.01'),
      taxRoundingTest(
        '#935 F35-F44 BDD 31.4925 publishes 31.49 with -0.0025 as Tax rounding evidence, no balancing haler',
      ),
      taxResultTest('#936 F35-F37 purchase total is the exact sum of published unit amounts, never re-rounded'),
      taxRoundingTest('#935 F53-F55 retrying the same exact evaluation gives the same haler'),
    ],
  ),
  kernel(
    'equal-rate-units',
    962,
    ['H5', 'BDD-equal-rate', 'G-equal-rate'],
    [
      taxRoundingTest('#935 F31-F34 BDD two 21 % units of one Decision are rounded independently'),
      taxDecisionTest('#936 F10-F11 equal-valued units with the same rate are not merged'),
      SCENARIO_3,
    ],
  ),
  kernel(
    'published-line-value',
    962,
    ['H6'],
    [taxableBasisTest('#931 F3-F4 BDD uses the published 100.00 CZK Line Commercial Value, not Pricing internals')],
    ['pricingLine'],
  ),
  kernel(
    'contributions-once',
    962,
    ['H7', 'BDD-discount', 'BDD-fee', 'G-discount', G_PROMOTION, 'G-fees'],
    [
      taxableBasisTest(
        '#931 F7-F11 #932 F7-F9 BDD Discount, Promotion and Fees are included exactly once and kept as evidence',
      ),
      taxableBasisTest('#932 F10-F13 F22 BDD a fee label never creates a separate supply, component or treatment'),
      shippingAllocationTest(
        '#932 F18-F20 BDD a Pricing Fee stays inside the line and Shipping is a separate component, each counted once',
      ),
    ],
    ['pricingLine', 'shippingCharge'],
  ),
  kernel(
    'shipping-conservation',
    962,
    ['H8', 'BDD-mixed-rate-shipping', 'G-shipping-mixed', 'PO-rational-1-6'],
    [
      shippingAllocationTest(
        '#962 PO #933 F21 #935 F13-F14 allocates 1 CZK at 1:6 exactly as 1/7 + 6/7 with no intermediate rounding',
      ),
      shippingAllocationTest(
        '#933 F17-F20 #935 F16 BDD mixed-rate allocations keep each unit treatment and round only per unit',
      ),
      taxEvaluationTest('D3-7 display (largest-remainder) shares never feed back into the exact tax'),
    ],
    ['shippingCharge'],
  ),
  kernel(
    'shipping-one-rate',
    962,
    ['G-shipping-one-rate'],
    [
      shippingAllocationTest(
        '#933 F4 F14 BDD one affected unit receives the whole unchanged 120.00 CZK owner-issued amount',
      ),
    ],
    ['shippingCharge'],
  ),
  kernel(
    'shipping-subset',
    962,
    ['G-shipping-subset'],
    [
      taxEvaluationTest(
        'D3-10 an affected subset of 2 out of 3 units at the same rate gets the exact gross-weighted shares; the unaffected unit has none',
      ),
    ],
    ['shippingCharge'],
  ),
  kernel(
    'shipping-zero',
    962,
    ['G-shipping-zero'],
    [shippingAllocationTest('#962 F32 #933 G authoritative zero Shipping stays zero for every affected unit')],
    ['shippingCharge'],
  ),
  kernel(
    'shipping-unavailable',
    962,
    ['BDD-shipping-unavailable', 'G-shipping-unavailable'],
    [shippingAllocationTest('#933 F8-F10 #962 F33 stale or unavailable Shipping is never zero Shipping')],
    ['shippingCharge'],
  ),
  kernel(
    'whole-set',
    962,
    ['H9', 'BDD-whole-set', G_WHOLE_SET],
    [
      taxableSupplyUnitTest(
        '#920 F25-F26 #934 F11 F22-F23 maps a whole-treatment Set to one unit without component prices',
      ),
      taxableBasisTest(
        '#934 F11 F21-F22 BDD a whole-treatment Set uses its full 1000.00 CZK without component allocation',
      ),
      SCENARIO_4,
    ],
  ),
  kernel(
    'unsupported-set',
    962,
    ['H10', 'BDD-unsupported-set', 'G-unsupported-set'],
    [
      taxableSupplyUnitTest(
        '#920 F29-F30 #918 F39 a Set requiring several taxable supplies is TAX_CASE_UNSUPPORTED with no split',
      ),
      taxEvaluationTest('#920 F29-F30 a multi-supply Set is unsupported, never split'),
    ],
  ),
  kernel(
    'taxable-zero',
    962,
    ['H11', 'BDD-zero', G_TAXABLE_ZERO],
    [
      taxEvaluationTest(
        '#962 BDD zero a supported VAT_PAYER line of 0.00 CZK is a successful taxable 0.00, not zero-rate, exempt or non-payer',
      ),
      taxResultTest('#936 F27 #939 F3-F4 a successful zero keeps the taxable Decision that explains it'),
      taxOutcomeTest('#936 F27 #939 F1-F2 F10 a zero amount without a Decision is not a successful outcome'),
      customerSafeTaxProjectionTest(
        'Unit 10 A5 a NON_PAYER seller always projects to SELLER_NOT_VAT_PAYER, whatever the decomposition need',
      ),
      SCENARIO_10,
    ],
  ),
  kernel(
    'non-success-no-zero',
    962,
    ['H11'],
    [taxNonSuccessOutcomeTest('#938 F2 #939 F14-F25 non-success outcomes never carry a Tax amount')],
  ),
  kernel(
    'rule-missing',
    962,
    ['BDD-rule-missing', 'G-rule-gap', 'H13'],
    [
      taxRuleSelectionTest(
        '#929 F10 T == effective_to excludes the ended revision and a later gap is TAX_RULE_MISSING (#930 F1)',
      ),
      SCENARIO_5,
    ],
  ),
  kernel(
    'half-open',
    962,
    ['H12', 'BDD-half-open', 'G-effective-from', 'G-effective-to'],
    [
      taxRuleSelectionTest('#929 F4-F6 boundary: T == effective_from of R2 selects R2, the instant before selects R1'),
      taxRuleSelectionTest(
        '#929 F10 T == effective_to excludes the ended revision and a later gap is TAX_RULE_MISSING (#930 F1)',
      ),
      FINAL_RULES_AT_T,
    ],
  ),
  kernel(
    'overlap-conflict',
    962,
    ['H13', 'G-overlap-conflict'],
    [
      taxRuleSelectionTest(
        '#930 F2 two simultaneously applicable revisions of one Tax Rule are TAX_RULE_OVERLAP, whatever their rates',
      ),
      taxRuleSelectionTest(
        '#930 F3 different Tax Rules with incompatible rates at T and no governing composition are TAX_RULE_CONFLICT',
      ),
      taxRuleSelectionTest(
        '#929 F13 F18 #907 F59 selection is deterministic and ignores insertion order and revision number',
      ),
    ],
  ),
  kernel('empty-observation', 962, ['BDD-empty-observation', G_INCOMPLETE], [INCOMPLETE_RULE_STATE]),
  kernel(
    'cumulative-correction',
    962,
    ['PO-cumulative-partial', 'PO-exhaustion-zero', 'PO-no-cross-unit'],
    [
      CUMULATIVE_PARTIAL,
      taxCorrectionDeltaTest(
        '#948 F21 F24 #907 F189 correcting one unit never moves Tax or a rounding remainder to another unit',
      ),
    ],
    ['acceptedTaxTermsInput'],
  ),
  notApplicable(
    'approved-rules-only',
    962,
    ['H14'],
    LEDGER_TITLES_GUARD,
    'Every mapped test is named by the issue rule it proves, and the ledger test checks every title verbatim',
  ),
  superseded('prerequisite-not-met-zero', 962, ['F47'], 'OWNERSHIP-FINAL §3', ['prerequisite-literal-deleted']),
  kernel(
    'prerequisite-literal-deleted',
    962,
    ['H11'],
    [taxNonSuccessOutcomeTest('Unit 10 A3 TAX_PREREQUISITE_NOT_MET is not in TaxNonSuccessOutcomeSchema')],
  ),
  gated(
    'promotion-e2e',
    962,
    [G_PROMOTION],
    'PROMOTION',
    894,
    '#894 is PARK: Promotion→Pricing→Tax is not executed; TAX uses a Promotion contribution inside the pricingLine double',
  ),
];

const ledger963: readonly TaxAcceptanceRow[] = [
  // §1 Dependency, stale and incomplete state.
  kernel(
    'unavailable-dependency',
    963,
    ['§1.1', '§1.2'],
    [
      taxNonSuccessOutcomeTest(
        '#938 F13-F15 F20-F32 an input that cannot be established is stale, unavailable or indeterminate, never negative',
      ),
      SCENARIO_6,
    ],
  ),
  notApplicable(
    'owner-guarantee',
    963,
    ['§1.3'],
    SCENARIO_6,
    'No Launch owner offers a guarantee for a declared fact (OWNERSHIP §7 #941/#942); an outage stays TAX_DEPENDENCY_UNAVAILABLE',
  ),
  kernel('completeness', 963, ['§1.4'], [INCOMPLETE_RULE_STATE, SCENARIO_5]),
  persisted(
    'no-torn-batch',
    963,
    ['§1.5'],
    [
      govPg(
        '#930 F6-F7 #942 F15 F18 a correction committed during a governed read is wholly visible or wholly absent, never torn',
      ),
    ],
    [],
  ),
  kernel(
    'b2b-buyer-status',
    963,
    ['§1.6'],
    [
      launchCoverageTest('#918 F3 F6-F9 #923 F6-F8 F14-F15 ordinary B2B is supported whatever the buyer VAT status'),
      SCENARIO_2,
    ],
  ),
  // §2 Races inside one evaluation.
  kernel(
    'evaluation-race',
    963,
    ['§2.1', '§2.2', '§2.6', 'BDD-rule-changes-inside'],
    [
      taxEvaluationAttemptTest(
        '#942 BDD material set change discards the obsolete candidate and retries on fresh state only',
      ),
      taxEvaluationAttemptTest('#942 F19 persistent change exhausts the bound without publishing a candidate'),
      taxEvaluationAttemptTest(
        'a changed rule-set outcome or seller declaration head with an equal fingerprint is still a change',
      ),
    ],
  ),
  persisted('declaration-race', 963, ['§2.1'], [FINAL_DECLARE_RACE]),
  persisted(
    'fixed-t',
    963,
    ['§2.3', '§2.4', '§2.5', 'BDD-crosses-boundary'],
    [
      FINAL_RULES_AT_T,
      taxTimeTest(
        '#941 F2-F4 F10 #907 F155-F156 final Launch Order Tax-Relevant Time is exactly Order Commitment Time T',
      ),
    ],
  ),
  // §3 Durable finalization.
  persisted('durable-final', 963, ['§3.1', '§3.4', 'BDD-lost-response'], [FINAL_AT_T, SCENARIO_9]),
  persisted('concurrent-finals', 963, ['§3.2'], [FINAL_CONCURRENT]),
  persisted('crash-before-final', 963, ['§3.3'], [FINAL_CRASH_BEFORE_COMMIT]),
  gated(
    'unknown-finalization-and-bundle-association',
    963,
    ['§3.5', '§3.6'],
    'COMMERCE',
    331,
    '#331 is PARK: unknown commit and Bundle/Attempt association are not executed; TAX recovers by submissionRef (durable-final)',
  ),
  // §4 Frozen Bundle and handoff.
  persisted(
    'frozen-final-not-recomputed',
    963,
    ['§4.1', '§4.2', '§4.3', 'BDD-ordinary-change'],
    [FINAL_AT_T, FINAL_CORRECTION_NAMED, FINAL_BACKDATED, SCENARIO_9],
  ),
  gated(
    'bundle-commerce-handoff',
    963,
    ['§4.1', '§4.2', '§4.3', '§4.5', '§4.6', 'BDD-customer-terms'],
    'COMMERCE',
    330,
    '#330 is PARK: Bundle continuation, replacement candidates and customer reconfirmation are not executed',
  ),
  gated('unknown-order-commit', 963, ['§4.4'], 'ORDER', 331, '#331 is PARK: unknown Order commit is not executed'),
  kernel(
    'approval-compatibility',
    963,
    ['§4.7', 'BDD-approval-compatibility'],
    [
      taxMaterialityTest('#943 F9 F12 a final candidate with a new Pricing Result but equal amounts keeps its meaning'),
      taxMaterialityTest('#943 F10 the same old/new states give the same conclusion'),
    ],
  ),
  gated(
    'approval-phases',
    963,
    ['§4.7', '§4.8'],
    'APPROVAL',
    323,
    '#323 is PARK: Approval phases 1-2 are not executed',
  ),
  kernel(
    'evidence-only-equivalence',
    963,
    ['§4.9'],
    [
      taxMaterialityTest(
        '#943 BDD R2 replacing R1 with preserved meaning may be attested non-material, naming the change',
      ),
      taxMaterialityTest('#943 F8 a non-success outcome is unverifiable, not an implicit attestation'),
    ],
  ),
  // §5 Independent actual-time checks.
  kernel(
    't-is-business-instant',
    963,
    ['§5.1'],
    [
      taxTimeTest(
        '#941 F1 #929 F11-F12 #907 F142-F143 Tax Evaluation Time is a distinct type that cannot select rule effectivity',
      ),
    ],
  ),
  notApplicable(
    'no-tax-proof',
    963,
    ['§5.2', '§5.4'],
    NO_TTL_GUARD,
    'TAX issues no proof with a lifetime; nothing exists to revive',
  ),
  gated(
    'inventory-reservation',
    963,
    ['§5.3'],
    'INVENTORY',
    877,
    '#877 is PARK: Inventory Reservation/Confirmation is not executed',
  ),
  // §6 Governance concurrency.
  persisted(
    'governance-cas',
    963,
    ['§6.1', '§6.2', '§6.3', '§6.4', '§6.5', 'BDD-governance-lost'],
    [
      govPg(
        '#929 #930 F8 #955 Tax Rule governance replays, rejects reused keys and stale bases, and keeps corrections addressable',
      ),
      govPg(
        '#949 F20 #955 concurrent writers with the same expected-current basis: exactly one wins, the other is stale',
      ),
      declPg('Unit 10 B CAS rejects a declare whose basis is already stale'),
      declPg('#955 G a Core-invocation replay echoes the original result, including its replaced-revision refs'),
      declPg('Unit 10 B two sequential declares each get the next revision, and two concurrent ones serialize to it'),
    ],
    [],
  ),
  notApplicable('no-delivery-debt', 963, ['§6.6'], NO_OUTBOX_GUARD, 'TAX publishes no Outbox message or domain event'),
  // §7 History and original-record returns.
  persisted('history-not-rewritten', 963, ['§7.1', '§7.2'], [FINAL_CORRECTION_NAMED, FINAL_BACKDATED]),
  kernel(
    'confirmed-wrong-provenance',
    963,
    ['§7.2'],
    [taxRuleSelectionTest('#930 F8-F9 a confirmed-wrong revision is never applicable and its provenance is returned')],
  ),
  kernel(
    'billing-document-record',
    963,
    ['§7.3', 'BDD-changed-masters'],
    [
      CORRECTION_HISTORICAL_READ,
      taxCorrectionDeltaTest('C-1 a correction request whose Terms are the Order Snapshot fails to decode (H10)'),
      taxCorrectionPreviewTest(
        'C-2 a declared CORRECTION over the Order Snapshot fails to decode; over the Billing Document it previews',
      ),
      taxCorrectionPreviewTest(
        'C-3 HISTORICAL_READ and NEW_EVENT over the Order Snapshot are still answered (pre-document boundary)',
      ),
      corrHttp('c. a retry after recovery over the real Billing Document previews a Tax Correction Delta'),
    ],
    ['acceptedTaxTermsInput'],
  ),
  superseded('b2c-order-snapshot-record', 963, ['§7.3-b2c-order-snapshot'], 'UNIT12 H10', ['billing-document-record']),
  kernel(
    'history-owner-outage',
    963,
    ['§7.4'],
    [
      corrHttp('a. HISTORY_OWNER_UNAVAILABLE + CORRECTION is a typed 200, never the unavailable problem'),
      corrHttp('b. ORIGINAL_RECORD_UNAVAILABLE MISSING stays TAX_HISTORICAL_INPUT_UNRESOLVED, distinct from D4'),
      taxCorrectionPreviewTest(
        '#947 F13 #948 F7 an original record the owner cannot establish is the explicit unresolved outcome',
      ),
    ],
    ['acceptedTaxTermsInput'],
  ),
  kernel(
    'cumulative-corrections',
    963,
    ['§7.5', '§7.6', 'BDD-full-cumulative'],
    [
      CUMULATIVE_PARTIAL,
      taxCorrectionDeltaTest(
        '#948 F22 G a value correction followed by returns still exhausts the unit to exactly 0.00 CZK',
      ),
      taxCorrectionDeltaTest(
        '#948 F16 already corrected quantity or basis is not consumed twice and nothing is clamped',
      ),
      taxCorrectionDeltaTest(
        '#948 F21 F24 #907 F189 correcting one unit never moves Tax or a rounding remainder to another unit',
      ),
      EXPECTED_STATE_ECHO,
    ],
    ['acceptedTaxTermsInput'],
  ),
  kernel(
    'competing-correction-tax-side',
    963,
    ['§7.5', BDD_COMPETING_CORRECTION],
    [EXPECTED_STATE_ECHO],
    ['acceptedTaxTermsInput'],
  ),
  gated(
    'billing-accepts-first',
    963,
    [BDD_COMPETING_CORRECTION],
    'BILLING',
    253,
    'Billing accepting the first correction is not executed; no Billing issue exists yet (OWNERSHIP §8 item 2), so the roadmap #253 is named',
  ),
  persisted(
    'privacy-disposition',
    963,
    ['§7.7'],
    [
      privPg('#956 F19 a seller with no TAX content is complete NO_DATA over every TAX responsibility'),
      privPg('#956 F13-F16 a seller with a finalized Order Tax finds its own finalization evidence'),
      taxPrivacyOwnerContractTest(
        'never fabricates deletion: TAX has no supported disposition lifecycle for its evidence (F32, F38-F40)',
      ),
    ],
    [],
  ),
  // §8 Determinism and wrong-at-T.
  kernel(
    'unchanged-failure-stays',
    963,
    ['§8.1'],
    [launchCoverageTest('#938 F34 F41 the same unchanged unsupported case stays unsupported on repeated evaluation')],
  ),
  persisted('wrong-at-t-tax-side', 963, ['§8.2'], [FINAL_CORRECTION_NAMED]),
  gated(
    'wrong-at-t-resubmit',
    963,
    ['§8.2'],
    'ORDER',
    331,
    '#331 is PARK: stop, close-and-resubmit after a wrong-at-T final is not executed',
  ),
  kernel('evidence-record', 963, ['G-evidence-record'], [LEDGER_GATED_GUARD, LEDGER_D6_GUARD]),
];

export const taxAcceptanceLedger: readonly TaxAcceptanceRow[] = [...ledger961, ...ledger962, ...ledger963];
