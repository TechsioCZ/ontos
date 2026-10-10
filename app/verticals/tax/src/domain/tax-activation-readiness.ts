import { DateTime, Match, Order, Result } from 'effect';

import { TaxActivationItemIdSchema } from '../../shared/domain/tax-activation-contracts.ts';
import type {
  TaxActivationBlocker,
  TaxActivationEvidence,
  TaxActivationEvidenceRejected,
  TaxActivationItemId,
  TaxActivationItemOwner,
  TaxActivationItemScope,
  TaxActivationReadiness,
  TaxActivationResolution,
} from '../../shared/domain/tax-activation-contracts.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import { sellerVatRegimeAt } from './seller-vat-regime-timeline.ts';

/** One #964 activation item: who resolves it, for which scope, and the rule it comes from. */
export interface TaxActivationItem {
  readonly owner: TaxActivationItemOwner;
  /** `COMPUTED` items are derived by TAX from TAX state and cannot be resolved by an evidence reference. */
  readonly resolvedBy: 'COMPUTED' | 'EVIDENCE';
  readonly scope: TaxActivationItemScope;
  readonly source: string;
  readonly summary: string;
}

const legal = (question: number, summary: string): TaxActivationItem => ({
  owner: 'LEGAL',
  resolvedBy: 'EVIDENCE',
  scope: 'ACTIVATION',
  source: `LEGAL-FINAL §7 question ${question}`,
  summary,
});
const operations = (source: string, summary: string): TaxActivationItem => ({
  owner: 'TAX_OPERATIONS',
  resolvedBy: 'EVIDENCE',
  scope: 'ACTIVATION',
  source,
  summary,
});
const activationItem = (owner: TaxActivationItemOwner, source: string, summary: string): TaxActivationItem => ({
  owner,
  resolvedBy: 'EVIDENCE',
  scope: 'ACTIVATION',
  source,
  summary,
});

const OWNER_ACCEPTANCE_SOURCE = '#964 F8-F14';

/**
 * The closed #964 catalogue. The caller cannot narrow it: every item applies to every activation (the
 * `taxMigrationFamilies` precedent). Legal, Billing, Catalog and PO items stay open until their owner resolves them.
 */
export const TAX_ACTIVATION_ITEMS = {
  B2C_GROSS_AMOUNT_BASIS_CONTRACT: activationItem(
    'PRICING_DELIVERY',
    'Unit 11 decision 2; LEGAL-FINAL §2',
    'Pricing and Delivery publish B2C line and Shipping amounts as GROSS (VAT-inclusive) under an agreed contract',
  ),
  BILLING_ISSUANCE_GUARD: activationItem(
    'BILLING',
    'OWNERSHIP-FINAL §4, R2; LEGAL-FINAL §3',
    'Billing blocks issuing a document in the wrong regime or after a regime or rate change between T and the event',
  ),
  BILLING_PAYER_DIC_GATE: {
    owner: 'BILLING',
    resolvedBy: 'EVIDENCE',
    scope: 'PER_PAYER_SELLER',
    source: 'OWNERSHIP-FINAL §7 #961/#964; LEGAL-FINAL §6.2',
    summary:
      'Billing requires the assigned supplier and buyer DIČ on full § 29 documents; only an evidenced § 29(3)(a)/(b) non-assignment is an exception',
  },
  CATALOG_TAX_PURPOSE_CONTRACT: activationItem(
    'CATALOG',
    '#964 F24a-d, H; OWNERSHIP-FINAL H12',
    'Catalog publishes the #926 Tax-purpose evidence contract; until then TAX labels Catalog facts CALLER_SUPPLIED_UNVERIFIED',
  ),
  D3_CONTRACT_TEXTS_RECONCILED: activationItem(
    'PO',
    'LEGAL-FINAL §2',
    'The PO reconciles #931 F3, #933 F21 and #935 F14 with the approved D3 method',
  ),
  DEACTIVATION_PLAN: operations('#964 F110-F117', 'Deactivation keeps one authority and Accepted history unchanged'),
  LEGAL_D3A: legal(4, 'VAT per Taxable Supply Unit under § 37 písm. b), rounded once HALF_UP, totals as sums'),
  LEGAL_L1A: legal(1, 'A non-payer’s taxable domestic sale is a § 50(1) exempt supply'),
  LEGAL_L1B: legal(2, 'The non-payer invoice statement and whether DIČ is omitted by default'),
  LEGAL_L2: legal(3, 'The approved Shipping allocation key (default: published gross line values)'),
  LEGAL_L3A: legal(5, 'The delivery events that set DUZP per flow'),
  LEGAL_L3B: legal(6, 'The payment receipt event and its evidence under the card/PSP and bank-transfer contracts'),
  LEGAL_L4: legal(11, 'Document field lists A, C, D and always issuing the full § 29 document'),
  LEGAL_L5: legal(12, 'An identified person’s domestic supply is treated as a non-payer’s'),
  LEGAL_Q5A: legal(7, 'Advances received around the start of payer status'),
  LEGAL_Q5B: legal(8, 'Payer at T and non-payer at DUZP with no taxed advance'),
  LEGAL_Q5C: legal(9, 'An advance taxed while a payer, then delivery after deregistration'),
  LEGAL_Q5D: legal(10, 'The block, staff confirmation and 15-day issuance control'),
  MIGRATION_RECONCILIATION: operations(
    '#964 F72-F82',
    'Migration reconciliation is READY (assessTaxMigrationReadiness) or stated not applicable',
  ),
  MUTATION_RECOVERY: operations('#964 F59-F64', 'Governed mutations recover by idempotency and expected-current state'),
  OPERATIONAL_RUNBOOK: operations('#964 F100-F109', 'A reviewed operational runbook exists'),
  OPERATIONAL_SIGNALS: operations(
    '#964 F91-F99',
    'Signals for TAX_RULE_MISSING, TAX_RULE_OVERLAP, TAX_RULE_CONFLICT, TAX_INPUT_STALE, TAX_DEPENDENCY_UNAVAILABLE, TAX_STATE_INDETERMINATE and failed or stale governance mutations',
  ),
  OWNER_ACCEPTANCE_961: activationItem(
    'TAX',
    OWNER_ACCEPTANCE_SOURCE,
    'A CI run of #961 owner acceptance for the deployed revision',
  ),
  OWNER_ACCEPTANCE_962: activationItem(
    'TAX',
    OWNER_ACCEPTANCE_SOURCE,
    'A CI run of #962 edge acceptance for the deployed revision',
  ),
  OWNER_ACCEPTANCE_963: activationItem(
    'TAX',
    OWNER_ACCEPTANCE_SOURCE,
    'A CI run of #963 failure, race and history acceptance for the deployed revision',
  ),
  PARTIAL_CREDIT_RULE_APPROVED: activationItem(
    'LEGAL',
    'LEGAL-FINAL §2 Credits; Unit 12 decision 5',
    'The partial-credit rounding rule is approved',
  ),
  PERMISSIONS_AND_AUDIT: operations(
    '#964 F51-F58',
    'Production permissions and audit, with the declaration permission separate from Tax Rule management',
  ),
  PRIVACY_OWNER_INVENTORY: activationItem('PRIVACY', '#964 F65-F71', 'The Privacy owner inventory covers TAX data'),
  PRODUCTION_SCOPE_INVENTORY: operations(
    '#964 F15-F24',
    'The reviewed Tenant, Selling Legal Entity and Tax-case inventory in CZK, with no fixture identities',
  ),
  Q5_LAUNCH_FLOWS_DECIDED: activationItem(
    'PO',
    'OWNERSHIP-FINAL Q5, §4; LEGAL-FINAL §6.3',
    'The supported Launch flows, and a staff procedure or an explicit restriction for blocked cases',
  ),
  REQUIRED_SOURCE_ROUTES: operations(
    '#964 F42-F50',
    'Every required source route is activated; Launch has no external fact family and no external seller route, which must still be stated',
  ),
  SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION: {
    owner: 'TAX',
    resolvedBy: 'COMPUTED',
    scope: 'PER_SELLER',
    source: '#964 F25-F27 as patched by OWNERSHIP-FINAL §7; R1',
    summary: 'Every activated Selling Legal Entity has a Seller VAT Regime Declaration covering activation',
  },
  TAX_RULE_COVERAGE: operations(
    '#964 F33-F41',
    'Complete production Tax Rule and classification coverage for payer sellers',
  ),
  UNSUPPORTED_CASES_FAIL_CLOSED: activationItem(
    'TAX',
    '#964 F83-F90',
    'Unsupported cases fail closed with no domestic or currency fallback',
  ),
} as const satisfies Record<TaxActivationItemId, TaxActivationItem>;

const NOT_DECLARED: SellerVatRegimeAtInstantSelection = { _tag: 'NOT_DECLARED' };

type SellerHistory = TaxActivationEvidence['sellerDeclarations'][number]['history'];

/**
 * The regime at activation, with the selected revision's effective time and provenance. Covered at `activationAt`
 * implies covered at every later instant: revisions are never retracted, and every later instant sees at least the
 * revisions live at `activationAt`.
 */
const selectionAt = (history: SellerHistory, activationAt: DateTime.Utc): SellerVatRegimeAtInstantSelection => {
  const selection = sellerVatRegimeAt(history.revisions, activationAt);
  return Match.value(selection).pipe(
    Match.tag('NOT_DECLARED', () => NOT_DECLARED),
    Match.tag('DECLARED', ({ declarationRevisionRef, regime }) => {
      const selected = history.revisions.find(({ revision }) => revision === declarationRevisionRef.revision);
      return selected === undefined
        ? NOT_DECLARED
        : {
            _tag: 'DECLARED' as const,
            declarationRevisionRef,
            effectiveFrom: selected.effectiveFrom,
            provenance: selected.provenance,
            regime,
          };
    }),
    Match.exhaustive,
  );
};

const isDeclared = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', () => true),
    Match.tag('NOT_DECLARED', () => false),
    Match.exhaustive,
  );

const isPayerAt = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime === 'VAT_PAYER'),
    Match.tag('NOT_DECLARED', () => false),
    Match.exhaustive,
  );

/** A payer at activation, or a seller with a VAT_PAYER revision scheduled after it (flag F3 default). */
const payerDicRequired = (
  history: SellerHistory | undefined,
  atActivation: SellerVatRegimeAtInstantSelection,
  activationAt: DateTime.Utc,
) =>
  isPayerAt(atActivation) ||
  (history?.revisions.some(
    ({ effectiveFrom, regime }) => regime === 'VAT_PAYER' && DateTime.isGreaterThan(effectiveFrom, activationAt),
  ) ??
    false);

type Rejection = TaxActivationEvidenceRejected['rejections'][number];

const resolutionRejections = (
  resolution: TaxActivationResolution,
  inScope: ReadonlySet<string>,
): readonly Rejection[] => {
  const item: TaxActivationItem = TAX_ACTIVATION_ITEMS[resolution.itemId];
  const { itemId, sellingLegalEntityRef } = resolution;
  if (item.resolvedBy === 'COMPUTED') {
    return [{ itemId, reason: 'COMPUTED_ITEM' }];
  }
  if (item.scope === 'ACTIVATION') {
    return sellingLegalEntityRef === undefined ? [] : [{ itemId, reason: 'SELLER_NOT_ALLOWED', sellingLegalEntityRef }];
  }
  if (sellingLegalEntityRef === undefined) {
    return [{ itemId, reason: 'SELLER_REQUIRED' }];
  }
  return inScope.has(sellingLegalEntityRef) ? [] : [{ itemId, reason: 'SELLER_OUT_OF_SCOPE', sellingLegalEntityRef }];
};

const itemOrder = new Map(TaxActivationItemIdSchema.literals.map((itemId, index) => [itemId, index]));
const byItemThenSeller = Order.combine(
  Order.mapInput(Order.Number, ({ itemId }: TaxActivationBlocker) => itemOrder.get(itemId) ?? 0),
  Order.mapInput(Order.String, ({ sellingLegalEntityRef }: TaxActivationBlocker) => sellingLegalEntityRef ?? ''),
);

/**
 * #964 activation readiness of one exact scope, as NON_PRODUCTION evidence (flag F1: there is no production
 * evaluation path). Every ACTIVATION item needs a resolution; every seller needs a declaration covering activation;
 * every payer seller needs a Billing DIČ resolution. A resolution that does not fit its item is rejected, never
 * matched. The labels never claim activation or Commerce readiness.
 */
export const assessTaxActivationReadiness = (
  evidence: TaxActivationEvidence,
): Result.Result<TaxActivationReadiness, TaxActivationEvidenceRejected> => {
  const { scope } = evidence;
  const inScope = new Set<string>(scope.sellingLegalEntityRefs);
  const rejections: readonly Rejection[] = [
    ...evidence.sellerDeclarations.flatMap(({ sellingLegalEntityRef }) =>
      inScope.has(sellingLegalEntityRef) ? [] : [{ reason: 'SELLER_OUT_OF_SCOPE' as const, sellingLegalEntityRef }],
    ),
    ...evidence.resolvedItems.flatMap((resolution) => resolutionRejections(resolution, inScope)),
  ];
  const [firstRejection, ...otherRejections] = rejections;
  if (firstRejection !== undefined) {
    return Result.fail({ _tag: 'ACTIVATION_EVIDENCE_REJECTED', rejections: [firstRejection, ...otherRejections] });
  }

  const resolved = new Set(
    evidence.resolvedItems.map(({ itemId, sellingLegalEntityRef }) => `${itemId}\u0000${sellingLegalEntityRef ?? ''}`),
  );
  const isResolved = (itemId: TaxActivationItemId, sellingLegalEntityRef = '') =>
    resolved.has(`${itemId}\u0000${sellingLegalEntityRef}`);

  const sellers = scope.sellingLegalEntityRefs.map((sellingLegalEntityRef) => {
    const history = evidence.sellerDeclarations.find(
      (declaration) => declaration.sellingLegalEntityRef === sellingLegalEntityRef,
    )?.history;
    const atActivation = history === undefined ? NOT_DECLARED : selectionAt(history, scope.activationAt);
    return {
      atActivation,
      payerDicRequired: payerDicRequired(history, atActivation, scope.activationAt),
      sellingLegalEntityRef,
    };
  });

  const sellerBlockers: readonly TaxActivationBlocker[] = sellers.flatMap(
    ({ atActivation, payerDicRequired: dicRequired, sellingLegalEntityRef }) => [
      ...(isDeclared(atActivation)
        ? []
        : [{ itemId: 'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION' as const, sellingLegalEntityRef }]),
      ...(dicRequired && !isResolved('BILLING_PAYER_DIC_GATE', sellingLegalEntityRef)
        ? [{ itemId: 'BILLING_PAYER_DIC_GATE' as const, sellingLegalEntityRef }]
        : []),
    ],
  );
  const activationBlockers: readonly TaxActivationBlocker[] = TaxActivationItemIdSchema.literals.flatMap((itemId) =>
    TAX_ACTIVATION_ITEMS[itemId].scope === 'ACTIVATION' && !isResolved(itemId) ? [{ itemId }] : [],
  );
  const [firstBlocker, ...otherBlockers] = [...activationBlockers, ...sellerBlockers].toSorted(byItemThenSeller);

  return Result.succeed({
    activationClaim: 'NONE',
    commerceReadinessClaim: 'NONE',
    evidenceLabel: 'NON_PRODUCTION',
    scope,
    sellers,
    verdict:
      firstBlocker === undefined
        ? { _tag: 'READY' }
        : { _tag: 'NOT_READY', blockers: [firstBlocker, ...otherBlockers] },
  });
};
