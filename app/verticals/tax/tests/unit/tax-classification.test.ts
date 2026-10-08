import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxClassificationCodeSchema,
  TaxClassificationInputSchema,
  classifyCatalogSelection,
  isSameExactTaxClassificationBasis,
  launchTaxClassificationInterpretation,
} from '../../src/domain/tax-classification.ts';
import type { TaxClassificationBasis, TaxClassificationInterpretation } from '../../src/domain/tax-classification.ts';

const decodeInput = Schema.decodeUnknownSync(TaxClassificationInputSchema);

type ClassificationInputEncoded = typeof TaxClassificationInputSchema.Encoded;

const current = (
  catalogFactRef: string,
  catalogFactRevisionRef: string,
  factKind = 'TAX_CATEGORY',
  factValue = 'cz-standard-goods',
) =>
  ({
    _tag: 'CURRENT',
    catalogFactRef,
    catalogFactRevisionRef,
    factKind,
    factValue,
    ownerEvidenceRef: `owner-evidence:${catalogFactRef}`,
  }) as const;

const baseInput: ClassificationInputEncoded = {
  catalogSelection: { productRef: 'product-1', variantRef: 'variant-1' },
  evidencePurpose: 'TAX',
  materialCatalogEvidence: [current('variant-1:tax-category', 'r1')],
  materialEvidenceCompleteness: { _tag: 'OWNER_VERIFIED_COMPLETE', ownerEvidenceRef: 'completeness-1' },
};

const classificationInput = (overrides: Partial<ClassificationInputEncoded> = {}) =>
  decodeInput({ ...baseInput, ...overrides });

/** Test interpretation: a Tax-owned code derived only from the verified material fact revisions. */
const interpretByFactRevisions: TaxClassificationInterpretation = ({
  materialCatalogEvidence,
}: TaxClassificationBasis) =>
  Result.succeed(
    TaxClassificationCodeSchema.make(
      materialCatalogEvidence
        .map(({ catalogFactRef, catalogFactRevisionRef }) => `${catalogFactRef}@${catalogFactRevisionRef}`)
        .join('|'),
    ),
  );

const classify = (overrides: Partial<ClassificationInputEncoded> = {}) =>
  classifyCatalogSelection(classificationInput(overrides), interpretByFactRevisions);

const packageSelection = (pinnedContentRevisionRef: string) => ({
  packageOption: { packageOptionRef: 'package-1', pinnedContentRevisionRef },
  productRef: 'product-1',
  variantRef: 'variant-1',
});

const classified = (overrides: Partial<ClassificationInputEncoded> = {}) => Result.getOrThrow(classify(overrides));

describe('Tax Classification', () => {
  it('#926 F1 F6 H successful classification identifies the exact Catalog Selection and its owner evidence', () => {
    expect(classify()).toEqual(
      Result.succeed({
        catalogSelection: { productRef: 'product-1', variantRef: 'variant-1' },
        classificationCode: 'variant-1:tax-category@r1',
        completenessEvidenceRef: 'completeness-1',
        materialCatalogEvidence: [current('variant-1:tax-category', 'r1')],
      }),
    );
  });

  it('#926 F3-F4 #907 F44-F45 different Variants of one Product may classify differently', () => {
    const first = classified();
    const second = classified({
      catalogSelection: { productRef: 'product-1', variantRef: 'variant-2' },
      materialCatalogEvidence: [current('variant-2:tax-category', 'r1')],
    });

    expect(first.classificationCode).not.toBe(second.classificationCode);
    expect(isSameExactTaxClassificationBasis(first, second)).toBe(false);
  });

  it('#926 F5 F9 #907 F46 F50 a materially different configuration is not automatically the same classification', () => {
    const before = classified({
      catalogSelection: {
        productConfigurationRef: 'configuration-a',
        productRef: 'product-1',
        variantRef: 'variant-1',
      },
    });
    const after = classified({
      catalogSelection: {
        productConfigurationRef: 'configuration-b',
        productRef: 'product-1',
        variantRef: 'variant-1',
      },
    });

    expect(isSameExactTaxClassificationBasis(before, after)).toBe(false);
  });

  it('#926 F5 F9 G a Package Content Revision change without ProductRef change is a different basis', () => {
    expect(
      isSameExactTaxClassificationBasis(
        classified({ catalogSelection: packageSelection('content-r1') }),
        classified({ catalogSelection: packageSelection('content-r2') }),
      ),
    ).toBe(false);
  });

  it('#926 F9 F12 BDD Set Composition R1 to R2 change is not treated as Current for R2', () => {
    const forSetRevision = (revision: number) =>
      classified({
        catalogSelection: {
          productRef: 'set-product-1',
          setCompositionRevisionRef: { revision, setCompositionId: 'set-1' },
          variantRef: 'set-variant-1',
        },
        materialCatalogEvidence: [current('set-1:composition', `r${revision}`)],
      });

    expect(isSameExactTaxClassificationBasis(forSetRevision(1), forSetRevision(2))).toBe(false);
    expect(isSameExactTaxClassificationBasis(forSetRevision(1), forSetRevision(1))).toBe(true);
  });

  it('#926 F7 F10 #907 F48 display-only rename and SKU are not classification inputs', () => {
    const renamed = decodeInput({
      ...baseInput,
      catalogSelection: { ...baseInput.catalogSelection, displayName: 'Renamed product', sku: 'SKU-NEW' },
      displayName: 'Renamed product',
      sku: 'SKU-NEW',
    });
    const renamedClassification = Result.getOrThrow(classifyCatalogSelection(renamed, interpretByFactRevisions));

    expect(Object.keys(renamed.catalogSelection).toSorted()).toEqual(['productRef', 'variantRef']);
    expect(renamedClassification).toEqual(classified());
    expect(isSameExactTaxClassificationBasis(renamedClassification, classified())).toBe(true);
  });

  it('#926 H acceptance determinism: evidence order does not change the classification', () => {
    const facts = [current('variant-1:tax-category', 'r1'), current('category-ancestry', 'r4')] as const;
    const forward = classified({ materialCatalogEvidence: [facts[0], facts[1]] });
    const reversed = classified({ materialCatalogEvidence: [facts[1], facts[0]] });

    expect(forward).toEqual(reversed);
    expect(isSameExactTaxClassificationBasis(forward, reversed)).toBe(true);
  });

  it('#926 F11 #907 F51 a different revision with equal-looking values is not inferred equivalent', () => {
    expect(
      isSameExactTaxClassificationBasis(
        classified(),
        classified({ materialCatalogEvidence: [current('variant-1:tax-category', 'r2')] }),
      ),
    ).toBe(false);
  });

  it('#926 F13 #938 F20-F28 decisive evidence that is stale, unavailable, conflicting or unverifiable fails typed', () => {
    const withState = (state: 'STALE' | 'UNAVAILABLE' | 'CONFLICTING' | 'UNVERIFIABLE') =>
      classify({ materialCatalogEvidence: [{ _tag: 'NOT_USABLE', catalogFactRef: 'variant-1:tax-category', state }] });

    expect(withState('STALE')).toEqual(Result.fail({ _tag: 'TAX_INPUT_STALE' }));
    expect(withState('UNAVAILABLE')).toEqual(Result.fail({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' }));
    expect(withState('CONFLICTING')).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    expect(withState('UNVERIFIABLE')).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
  });

  it('#926 F12 BDD incomplete Set or ancestry evidence yields no classification from the partial set', () => {
    expect(
      classify({
        materialCatalogEvidence: [current('set-1:component-a', 'r1')],
        materialEvidenceCompleteness: { _tag: 'NOT_ESTABLISHED' },
      }),
    ).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
  });

  it('#926 F6 J handoff evidence issued for another Catalog purpose is not accepted as TAX evidence', () => {
    expect(() => decodeInput({ ...baseInput, evidencePurpose: 'PRICING' })).toThrow();
    expect(() => decodeInput({ ...baseInput, evidencePurpose: 'PURCHASE_ACCEPTANCE' })).toThrow();
  });

  it('#926 F13 a classification never proceeds without material Catalog evidence', () => {
    expect(() => decodeInput({ ...baseInput, materialCatalogEvidence: [] })).toThrow();
  });

  describe('Launch interpretation (PO decision D9 default)', () => {
    const launchClassify = (overrides: Partial<ClassificationInputEncoded> = {}) =>
      classifyCatalogSelection(classificationInput(overrides), launchTaxClassificationInterpretation);

    it('#926 F1 exactly one Current TAX_CATEGORY fact gives its value as the Tax Classification code', () => {
      const classification = Result.getOrThrow(
        launchClassify({
          materialCatalogEvidence: [
            current('variant-1:tax-category', 'r1', 'TAX_CATEGORY', 'cz-reduced-food'),
            current('category-ancestry', 'r4', 'CATEGORY_ANCESTRY', 'food'),
          ],
        }),
      );

      expect(classification.classificationCode).toBe('cz-reduced-food');
    });

    it('#926 F12-F13 no TAX_CATEGORY fact is indeterminate, never a default category', () => {
      expect(
        launchClassify({ materialCatalogEvidence: [current('category-ancestry', 'r4', 'CATEGORY_ANCESTRY', 'food')] }),
      ).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    });

    it('#926 F12-F13 two TAX_CATEGORY facts are indeterminate, never a chosen winner', () => {
      expect(
        launchClassify({
          materialCatalogEvidence: [
            current('variant-1:tax-category', 'r1', 'TAX_CATEGORY', 'cz-standard-goods'),
            current('product-1:tax-category', 'r2', 'TAX_CATEGORY', 'cz-reduced-food'),
          ],
        }),
      ).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    });
  });
});
