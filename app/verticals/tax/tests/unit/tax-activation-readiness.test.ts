import { Exit, Match, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxActivationEvidenceSchema,
  TaxActivationItemIdSchema,
  TaxActivationReadySchema,
} from '../../shared/domain/tax-activation-contracts.ts';
import type { TaxActivationEvidence, TaxActivationReadiness } from '../../shared/domain/tax-activation-contracts.ts';
import { TaxNonSuccessOutcomeSchema } from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';
import { TAX_ACTIVATION_ITEMS, assessTaxActivationReadiness } from '../../src/domain/tax-activation-readiness.ts';

type EvidenceInput = typeof TaxActivationEvidenceSchema.Encoded;
type RevisionInput = EvidenceInput['sellerDeclarations'][number]['history']['revisions'][number];

const TENANT = '10000000-0000-4000-8000-000000000001';
const ACTIVATION_AT = '2026-11-01T00:00:00.000Z';
const BEFORE = '2026-01-01T00:00:00.000Z';
const AFTER = '2027-01-01T00:00:00.000Z';

const revision = (number: number, regime: 'NON_PAYER' | 'VAT_PAYER', effectiveFrom: string): RevisionInput => ({
  declarationRef: {
    moduleId: 'commerce.tax',
    resourceId: `declaration-${number}`,
    resourceType: 'commerce.tax.seller-vat-regime-declaration',
    tenantId: TENANT,
  },
  declaredBy: '20000000-0000-4000-8000-000000000001',
  effectiveFrom,
  provenance: 'MERCHANT_DECLARED',
  reason: null,
  recordedAt: '2026-01-01T00:00:00.000Z',
  regime,
  replacesScheduled: false,
  revision: number,
});

const history = (sellingLegalEntityRef: string, revisions: readonly RevisionInput[]) => ({
  history: { completeness: { rowCount: revisions.length, setFingerprint: 'a'.repeat(64) }, revisions: [...revisions] },
  sellingLegalEntityRef,
});

const activationItemIds = TaxActivationItemIdSchema.literals.filter(
  (itemId) => TAX_ACTIVATION_ITEMS[itemId].scope === 'ACTIVATION',
);
const everyActivationItem = activationItemIds.map((itemId) => ({ evidenceRef: `evidence:${itemId}`, itemId }));

const evidence = (overrides: Partial<EvidenceInput> = {}): TaxActivationEvidence =>
  Schema.decodeSync(TaxActivationEvidenceSchema)({
    resolvedItems: [],
    scope: { activationAt: ACTIVATION_AT, sellingLegalEntityRefs: ['seller-a'], tenantRef: TENANT },
    sellerDeclarations: [],
    ...overrides,
  });

const readinessOf = (input: TaxActivationEvidence): TaxActivationReadiness =>
  Result.getOrThrowWith(assessTaxActivationReadiness(input), (rejected) => new Error(JSON.stringify(rejected)));

const isReady = Schema.is(TaxActivationReadySchema);

const blockersOf = (readiness: TaxActivationReadiness) =>
  Match.value(readiness.verdict).pipe(
    Match.tag('READY', () => []),
    Match.tag('NOT_READY', ({ blockers }) =>
      blockers.map(({ itemId, sellingLegalEntityRef }) =>
        sellingLegalEntityRef === undefined ? itemId : `${itemId}@${sellingLegalEntityRef}`,
      ),
    ),
    Match.exhaustive,
  );

const sellerBlockersOf = (readiness: TaxActivationReadiness) =>
  blockersOf(readiness).filter((blocker) => blocker.includes('@'));

describe('#964 TAX production activation gate', () => {
  it('#964 BDD fixture is not production evidence: nothing resolved blocks on every item and every undeclared seller', () => {
    const readiness = readinessOf(
      evidence({
        scope: { activationAt: ACTIVATION_AT, sellingLegalEntityRefs: ['seller-a', 'seller-b'], tenantRef: TENANT },
      }),
    );

    expect(blockersOf(readiness)).toEqual([
      'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION@seller-a',
      'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION@seller-b',
      ...activationItemIds,
    ]);
    expect(readiness.evidenceLabel).toBe('NON_PRODUCTION');
    expect(readiness.activationClaim).toBe('NONE');
    expect(readiness.commerceReadinessClaim).toBe('NONE');
  });

  describe('#964 patched F25 R1 a declaration covering activation, and a Billing DIČ item for payers', () => {
    const sellerOutcome = (revisions: readonly RevisionInput[]) =>
      readinessOf(
        evidence({ resolvedItems: everyActivationItem, sellerDeclarations: [history('seller-a', revisions)] }),
      );

    it('a: VAT_PAYER effective before activation needs only the DIČ item', () => {
      const readiness = sellerOutcome([revision(1, 'VAT_PAYER', BEFORE)]);
      expect(blockersOf(readiness)).toEqual(['BILLING_PAYER_DIC_GATE@seller-a']);
      expect(readiness.sellers).toMatchObject([{ payerDicRequired: true, sellingLegalEntityRef: 'seller-a' }]);
    });

    it('b: a revision effective only after activation does not cover it', () => {
      expect(sellerBlockersOf(sellerOutcome([revision(1, 'NON_PAYER', AFTER)]))).toEqual([
        'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION@seller-a',
      ]);
    });

    it('c: NON_PAYER at activation needs no DIČ item', () => {
      const readiness = sellerOutcome([revision(1, 'NON_PAYER', BEFORE)]);
      expect(blockersOf(readiness)).toEqual([]);
      expect(isReady(readiness.verdict)).toBe(true);
    });

    it('d: NON_PAYER at activation with a scheduled VAT_PAYER revision needs the DIČ item (flag F3)', () => {
      expect(blockersOf(sellerOutcome([revision(1, 'NON_PAYER', BEFORE), revision(2, 'VAT_PAYER', AFTER)]))).toEqual([
        'BILLING_PAYER_DIC_GATE@seller-a',
      ]);
    });

    it('a resolved DIČ item closes a payer seller', () => {
      const readiness = readinessOf(
        evidence({
          resolvedItems: [
            ...everyActivationItem,
            {
              evidenceRef: 'billing:dic-seller-a',
              itemId: 'BILLING_PAYER_DIC_GATE',
              sellingLegalEntityRef: 'seller-a',
            },
          ],
          sellerDeclarations: [history('seller-a', [revision(1, 'VAT_PAYER', BEFORE)])],
        }),
      );
      expect(isReady(readiness.verdict)).toBe(true);
    });
  });

  it('#964 a seller with no declaration entry is a blocker, never a default', () => {
    const readiness = readinessOf(evidence({ resolvedItems: everyActivationItem }));
    expect(blockersOf(readiness)).toEqual(['SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION@seller-a']);
    expect(readiness.sellers).toEqual([
      { atActivation: { _tag: 'NOT_DECLARED' }, payerDicRequired: false, sellingLegalEntityRef: 'seller-a' },
    ]);
  });

  it('#964 BDD owner ready, Commerce not: READY still claims no activation and no Commerce readiness', () => {
    const readiness = readinessOf(
      evidence({
        resolvedItems: everyActivationItem,
        sellerDeclarations: [history('seller-a', [revision(1, 'NON_PAYER', BEFORE)])],
      }),
    );
    expect(isReady(readiness.verdict)).toBe(true);
    expect(readiness.activationClaim).toBe('NONE');
    expect(readiness.commerceReadinessClaim).toBe('NONE');
    expect(readiness.evidenceLabel).toBe('NON_PRODUCTION');
  });

  it('#964 every open legal and adviser item blocks: 12 LEGAL questions plus Q5, D3 and partial credits', () => {
    const legalItems = TaxActivationItemIdSchema.literals.filter((itemId) => itemId.startsWith('LEGAL_'));
    expect(legalItems).toEqual([
      'LEGAL_L1A',
      'LEGAL_L1B',
      'LEGAL_L2',
      'LEGAL_D3A',
      'LEGAL_L3A',
      'LEGAL_L3B',
      'LEGAL_Q5A',
      'LEGAL_Q5B',
      'LEGAL_Q5C',
      'LEGAL_Q5D',
      'LEGAL_L4',
      'LEGAL_L5',
    ]);
    const questionSources = new Set(legalItems.map((itemId) => TAX_ACTIVATION_ITEMS[itemId].source));
    expect(questionSources).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => `LEGAL-FINAL §7 question ${index + 1}`)),
    );
    for (const itemId of [
      ...legalItems,
      'Q5_LAUNCH_FLOWS_DECIDED',
      'PARTIAL_CREDIT_RULE_APPROVED',
      'D3_CONTRACT_TEXTS_RECONCILED',
    ] as const) {
      const resolvedExceptOne = everyActivationItem.filter((resolution) => resolution.itemId !== itemId);
      const readiness = readinessOf(
        evidence({
          resolvedItems: resolvedExceptOne,
          sellerDeclarations: [history('seller-a', [revision(1, 'NON_PAYER', BEFORE)])],
        }),
      );
      expect(blockersOf(readiness), itemId).toEqual([itemId]);
    }
  });

  it('#964 no external seller route: no item is a seller authority, VIES, ARES, assertion or seller route', () => {
    expect(
      TaxActivationItemIdSchema.literals.filter((itemId) =>
        /AUTHORITY|VIES|ARES|ASSERTION|SELLER.*ROUTE/u.test(itemId),
      ),
    ).toEqual([]);
  });

  it('#964 F91-F99 the operational signals name only members of the #938 non-success set', () => {
    const isNonSuccess = Schema.is(TaxNonSuccessOutcomeSchema);
    const signalCodes = TAX_ACTIVATION_ITEMS.OPERATIONAL_SIGNALS.summary.match(/TAX_[A-Z_]+/gu) ?? [];
    expect(signalCodes).toEqual([
      'TAX_RULE_MISSING',
      'TAX_RULE_OVERLAP',
      'TAX_RULE_CONFLICT',
      'TAX_INPUT_STALE',
      'TAX_DEPENDENCY_UNAVAILABLE',
      'TAX_STATE_INDETERMINATE',
    ]);
    expect(signalCodes.filter((code) => !isNonSuccess({ _tag: code }))).toEqual([]);
    expect(isNonSuccess({ _tag: 'TAX_PREREQUISITE_NOT_MET' })).toBe(false);
  });

  it('#964 a resolution that does not fit its item is rejected, never matched', () => {
    const rejectedReasons = (resolvedItems: EvidenceInput['resolvedItems']) =>
      Result.match(assessTaxActivationReadiness(evidence({ resolvedItems })), {
        onFailure: ({ rejections }) => rejections.map(({ reason }) => reason),
        onSuccess: () => [],
      });

    expect(
      rejectedReasons([{ evidenceRef: 'dic', itemId: 'BILLING_PAYER_DIC_GATE', sellingLegalEntityRef: 'seller-z' }]),
    ).toEqual(['SELLER_OUT_OF_SCOPE']);
    expect(rejectedReasons([{ evidenceRef: 'dic', itemId: 'BILLING_PAYER_DIC_GATE' }])).toEqual(['SELLER_REQUIRED']);
    expect(
      rejectedReasons([{ evidenceRef: 'runbook', itemId: 'OPERATIONAL_RUNBOOK', sellingLegalEntityRef: 'seller-a' }]),
    ).toEqual(['SELLER_NOT_ALLOWED']);
    expect(
      rejectedReasons([
        {
          evidenceRef: 'claimed',
          itemId: 'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION',
          sellingLegalEntityRef: 'seller-a',
        },
      ]),
    ).toEqual(['COMPUTED_ITEM']);
    expect(
      Result.isFailure(
        assessTaxActivationReadiness(
          evidence({ sellerDeclarations: [history('seller-z', [revision(1, 'VAT_PAYER', BEFORE)])] }),
        ),
      ),
    ).toBe(true);
  });

  it('#964 an unknown item id or a duplicate resolution fails to decode', () => {
    const decode = Schema.decodeUnknownExit(TaxActivationEvidenceSchema);
    const scope = { activationAt: ACTIVATION_AT, sellingLegalEntityRefs: ['seller-a'], tenantRef: TENANT };
    expect(
      Exit.isFailure(
        decode({ resolvedItems: [{ evidenceRef: 'x', itemId: 'SELLER_AUTHORITY' }], scope, sellerDeclarations: [] }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          resolvedItems: [
            { evidenceRef: 'x', itemId: 'OPERATIONAL_RUNBOOK' },
            { evidenceRef: 'y', itemId: 'OPERATIONAL_RUNBOOK' },
          ],
          scope,
          sellerDeclarations: [],
        }),
      ),
    ).toBe(true);
  });
});
