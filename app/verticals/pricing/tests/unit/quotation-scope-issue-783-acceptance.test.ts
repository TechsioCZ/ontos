import {
  PricingCommitmentConfirmationReferenceSchema,
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationAuthorityBinding,
  PricingQuotationBinding,
  PricingQuotationIssued,
} from '@app/pricing-contracts/domain/quotation';
import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { makePricingQuotationScopeVerificationService } from '../../src/services/quotation-scope-verification.service.ts';
import {
  candidateRef,
  makeIssue779PreRoundScenario,
  requireIssue779ProductUnitRef,
} from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const quotationRef = 'pricing-quotation:783';

const guest = (
  guestSessionRef = 'guest-session:783:a',
  guestEvidenceRef = 'guest-evidence:783:a',
): PricingQuotationAuthorityBinding => ({
  guestEvidenceRef,
  guestSessionRef,
  kind: 'GUEST',
  purchaseContext: {
    contextRef: 'purchase-context:779',
    contextRevision: 'purchase-context-r779',
  },
});

const authenticated = (subjectId = '12121212-1212-4212-8212-121212121212') => ({
  kind: 'AUTHENTICATED' as const,
  purchaseContext: {
    contextRef: 'purchase-context:779',
    contextRevision: 'purchase-context-r779',
  },
  subjectEvidenceRef: 'subject-evidence:783',
  subjectRef: {
    moduleId: 'party.registry',
    resourceId: subjectId,
    resourceType: 'party.registry.engagement-profile',
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
});

const decodeBinding = Schema.decodeSync(PricingQuotationBindingSchema, { onExcessProperty: 'error' });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const quoteFixture = Effect.fn('test.issue783QuoteFixture')(function* issue783QuoteFixture() {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    discounts: ['0', '0', '0'],
    priceAmount: '100',
  });
  const publication = yield* publishPricingLineValues({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    return yield* Effect.die(`Issue #783 fixture expected publication: ${publication.failure.code}`);
  }
  const commercialTotal = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Issue #783 fixture expected a commercial total: ${commercialTotal.failure.code}`);
  }
  const binding = decodeBinding({
    candidateRef,
    commercialScope: commercialTotal.decision.commercialScope,
    currencyCode: commercialTotal.decision.currencyCode,
    lines: commercialTotal.decision.lines.map((line) => ({
      occurrenceId: line.occurrenceId,
      quantity: {
        amount: line.catalog.quantity.resulting,
        unitRef: requireIssue779ProductUnitRef(line.catalog.unitRef),
      },
      selection: line.catalog.selection,
    })),
    monetaryBoundary: commercialTotal.decision.monetaryBoundary,
    subject: guest(),
    tenantId: commercialTotal.decision.tenantId,
  });
  const quotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
    binding,
    issuedAt: commercialTotal.decision.operationTime,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
    quotationRef,
    quotedResult: commercialTotal,
    validity: {
      policyEvidence: {
        maximumValidityDurationMilliseconds: 86_400_000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '1',
      },
      validFrom: commercialTotal.decision.operationTime,
      validUntil: '2026-09-28T13:00:00.000Z',
    },
  });
  return { binding, quotation };
});

const verify = (quotation: PricingQuotationIssued, requestedBinding: PricingQuotationBinding) =>
  makePricingQuotationScopeVerificationService().verify({ quotation, requestedBinding });

describe('issue #783 exact Pricing Quotation scope acceptance', () => {
  it.effect('binds exact commercial, currency, Catalog, Quantity, Unit, and occurrence dimensions', () =>
    Effect.gen(function* bindsEveryPurchaseDimension() {
      const { binding, quotation } = yield* quoteFixture();
      const [line] = binding.lines;
      if (line === undefined) {
        return yield* Effect.die('Issue #783 fixture requires one bound line');
      }
      const otherTenant = '23232323-2323-4232-8232-232323232323';
      const catalogRef = <const ResourceType extends string>(resourceType: ResourceType, resourceId: string) => ({
        moduleId: 'commerce.catalog' as const,
        resourceId,
        resourceType,
        tenantId: binding.tenantId,
      });
      const packageRef = catalogRef('commerce.catalog.package-definition', '34343434-3434-4434-8434-343434343434');
      const changedBindings: readonly [PricingQuotationBinding, string][] = [
        [
          decodeBinding({
            ...binding,
            commercialScope: {
              ...binding.commercialScope,
              sellingLegalEntityId: '90909090-9090-4090-8090-909090909090',
            },
          }),
          'COMMERCIAL_SCOPE_MISMATCH',
        ],
        [
          decodeBinding({ ...binding, commercialScope: { ...binding.commercialScope, channelId: 'B2B' } }),
          'COMMERCIAL_SCOPE_MISMATCH',
        ],
        [
          decodeBinding({ ...binding, commercialScope: { ...binding.commercialScope, marketId: 'sk-launch' } }),
          'COMMERCIAL_SCOPE_MISMATCH',
        ],
        [decodeBinding({ ...binding, currencyCode: 'EUR' }), 'CURRENCY_MISMATCH'],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                selection: {
                  ...line.selection,
                  variantRef: {
                    ...line.selection.variantRef,
                    resourceId: '45454545-4545-4454-8454-454545454545',
                  },
                },
              },
            ],
          }),
          'SELECTION_MISMATCH',
        ],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                selection: {
                  ...line.selection,
                  packageOption: { contentRevision: { resourceRef: packageRef, revision: 2 }, optionRef: packageRef },
                },
              },
            ],
          }),
          'SELECTION_MISMATCH',
        ],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                selection: {
                  ...line.selection,
                  configuration: {
                    choices: [{ choiceKey: 'finish', value: 'matte' }],
                    definition: {
                      resourceRef: catalogRef(
                        'commerce.catalog.configuration-definition',
                        '56565656-5656-4656-8656-565656565656',
                      ),
                      revision: 3,
                    },
                    productRef: line.selection.productRef,
                    variantRef: line.selection.variantRef,
                  },
                },
              },
            ],
          }),
          'SELECTION_MISMATCH',
        ],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                selection: {
                  ...line.selection,
                  setComposition: {
                    resourceRef: catalogRef('commerce.catalog.set-composition', '67676767-6767-4767-8767-676767676767'),
                    revision: 4,
                  },
                },
              },
            ],
          }),
          'SELECTION_MISMATCH',
        ],
        [
          decodeBinding({ ...binding, lines: [{ ...line, quantity: { ...line.quantity, amount: '101' } }] }),
          'QUANTITY_MISMATCH',
        ],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                quantity: {
                  ...line.quantity,
                  unitRef: {
                    ...line.quantity.unitRef,
                    resourceId: '78787878-7878-4787-8787-787878787878',
                  },
                },
              },
            ],
          }),
          'QUANTITY_MISMATCH',
        ],
        [
          decodeBinding({ ...binding, lines: [{ ...line, occurrenceId: 'purchase-occurrence:other' }] }),
          'OCCURRENCE_STRUCTURE_MISMATCH',
        ],
        [
          decodeBinding({
            ...binding,
            lines: [
              {
                ...line,
                quantity: { ...line.quantity, unitRef: { ...line.quantity.unitRef, tenantId: otherTenant } },
                selection: {
                  ...line.selection,
                  productRef: { ...line.selection.productRef, tenantId: otherTenant },
                  variantRef: { ...line.selection.variantRef, tenantId: otherTenant },
                },
              },
            ],
            tenantId: otherTenant,
          }),
          'TENANT_MISMATCH',
        ],
      ];

      expect(yield* verify(quotation, binding)).toMatchObject({ kind: 'QUOTATION_SCOPE_APPLICABLE' });
      for (const [requestedBinding, reason] of changedBindings) {
        expect(yield* verify(quotation, requestedBinding)).toEqual({ kind: 'QUOTATION_SCOPE_MISMATCH', reason });
      }
      return yield* Effect.void;
    }),
  );

  it.effect('distinguishes 100 from 101 and one occurrence from two occurrences of 50', () =>
    Effect.gen(function* distinguishesQuantityAndPartition() {
      const { binding, quotation } = yield* quoteFixture();
      const [line] = binding.lines;
      if (line === undefined) {
        return yield* Effect.die('Issue #783 fixture requires one bound line');
      }
      const oneHundred = decodeBinding({
        ...binding,
        lines: [{ ...line, quantity: { ...line.quantity, amount: '100' } }],
      });
      const oneHundredOne = decodeBinding({
        ...binding,
        lines: [{ ...line, quantity: { ...line.quantity, amount: '101' } }],
      });
      const twoFifties = decodeBinding({
        ...binding,
        lines: [
          { ...line, occurrenceId: 'purchase-occurrence:a', quantity: { ...line.quantity, amount: '50' } },
          { ...line, occurrenceId: 'purchase-occurrence:b', quantity: { ...line.quantity, amount: '50' } },
        ],
      });
      const sameBinding = Schema.toEquivalence(PricingQuotationBindingSchema);

      expect(sameBinding(oneHundred, oneHundredOne)).toBe(false);
      expect(sameBinding(oneHundred, twoFifties)).toBe(false);
      expect(yield* verify(quotation, oneHundred)).toEqual({
        kind: 'QUOTATION_SCOPE_MISMATCH',
        reason: 'QUANTITY_MISMATCH',
      });
      expect(yield* verify(quotation, twoFifties)).toEqual({
        kind: 'QUOTATION_SCOPE_MISMATCH',
        reason: 'OCCURRENCE_STRUCTURE_MISMATCH',
      });
      return yield* Effect.void;
    }),
  );

  it.effect('rejects subject, Guest-session, Guest-evidence, and Guest-to-authenticated transfer', () =>
    Effect.gen(function* rejectsAuthorityTransfer() {
      const { binding, quotation } = yield* quoteFixture();
      const authorityChanges = [
        guest('guest-session:783:b', 'guest-evidence:783:a'),
        guest('guest-session:783:a', 'guest-evidence:783:b'),
        authenticated(),
        authenticated('89898989-8989-4989-8989-898989898989'),
      ];

      for (const subject of authorityChanges) {
        expect(yield* verify(quotation, decodeBinding({ ...binding, subject }))).toEqual({
          kind: 'QUOTATION_SCOPE_MISMATCH',
          reason: 'AUTHORITY_MISMATCH',
        });
      }
    }),
  );

  it.effect('does not let equal totals or source refs override exact purchase binding', () =>
    Effect.gen(function* rejectsSameMoneyAndSources() {
      const { binding, quotation } = yield* quoteFixture();
      const [line] = binding.lines;
      if (line === undefined) {
        return yield* Effect.die('Issue #783 fixture requires one bound line');
      }
      const otherPurchase = decodeBinding({
        ...binding,
        candidateRef: 'pricing-candidate:same-total-and-sources',
        lines: [{ ...line, occurrenceId: 'purchase-occurrence:same-total-and-sources' }],
      });
      const outcome = yield* verify(quotation, otherPurchase);

      expect(outcome).toEqual({ kind: 'QUOTATION_SCOPE_MISMATCH', reason: 'CANDIDATE_MISMATCH' });
      expect(quotation.quotedResult.pricingNetCommercialTotal.amount).toBe('100');
      expect(quotation.quotedResult.sourceEvidence).toBeDefined();
      expect(otherPurchase).not.toHaveProperty('pricingNetCommercialTotal');
      expect(otherPurchase).not.toHaveProperty('sourceEvidence');
      return yield* Effect.void;
    }),
  );

  it.effect('ignores Storefront and Tax presentation changes but never uses them to bypass authority', () =>
    Effect.gen(function* ignoresNonPricingDimensions() {
      const { binding, quotation } = yield* quoteFixture();
      const decorated = {
        ...binding,
        storefrontId: 'storefront:other',
        tax: { amount: '42', rate: '0.21', revisionRef: 'tax-revision:other' },
      };
      const applicable = yield* verify(quotation, decorated);

      expect(applicable).toMatchObject({ kind: 'QUOTATION_SCOPE_APPLICABLE' });
      if (applicable.kind !== 'QUOTATION_SCOPE_APPLICABLE') {
        return yield* Effect.die('Storefront and Tax-only changes must not alter Pricing scope');
      }
      expect(applicable.quotation.quotedResult.pricingNetCommercialTotal.amount).toBe('100');
      expect(applicable.binding).not.toHaveProperty('storefrontId');
      expect(applicable.binding).not.toHaveProperty('tax');

      expect(
        yield* verify(quotation, {
          ...decorated,
          subject: guest('guest-session:783:b', 'guest-evidence:783:b'),
        }),
      ).toEqual({ kind: 'QUOTATION_SCOPE_MISMATCH', reason: 'AUTHORITY_MISMATCH' });
      return yield* Effect.void;
    }),
  );

  it.effect('fails closed on absent or unverifiable bindings and activates neither EUR, FX, nor Confirmation', () =>
    Effect.gen(function* failsClosedWithoutActivation() {
      const { binding, quotation } = yield* quoteFixture();
      const service = makePricingQuotationScopeVerificationService();
      const invalidBinding = { ...binding, lines: [] };
      const invalidQuotation = { ...quotation, quotationRef: '' };

      expect(yield* service.verify({ quotation, requestedBinding: invalidBinding })).toEqual({
        kind: 'QUOTATION_SCOPE_UNVERIFIABLE',
        reason: 'INVALID_REQUESTED_BINDING',
      });
      expect(yield* service.verify({ quotation: invalidQuotation, requestedBinding: binding })).toEqual({
        kind: 'QUOTATION_SCOPE_UNVERIFIABLE',
        reason: 'INVALID_QUOTATION',
      });

      expect(
        Schema.is(PricingQuotationIssuedSchema)({ ...quotation, binding: { ...binding, currencyCode: 'EUR' } }),
      ).toBe(false);
      const encodedQuotation = yield* encodeJson(quotation);
      expect(encodedQuotation).not.toContain('exchangeRate');
      expect(encodedQuotation).not.toContain('converted');

      const applicable = yield* verify(quotation, binding);
      expect(applicable).toMatchObject({ kind: 'QUOTATION_SCOPE_APPLICABLE' });
      expect(applicable).not.toHaveProperty('confirmationRef');
      expect(Schema.is(PricingCommitmentConfirmationReferenceSchema)(applicable)).toBe(false);
    }),
  );
});
