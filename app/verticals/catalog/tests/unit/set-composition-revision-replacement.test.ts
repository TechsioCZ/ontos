import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import type { SetComponentCurrentProof } from '../../shared/domain/set-component-validation.ts';
import { validateSetComponents } from '../../shared/domain/set-component-validation.ts';
import {
  classifySetCompositionChange,
  correctSetComponentEvidence,
  replaceSetComponent,
  SetComponentRevisionChangeSchema,
  SetCompositionRevisionSchema,
  summarizeSetComponents,
} from '../../shared/domain/set-composition.ts';
import type { SetComponent, SetComponentRevisionChange } from '../../shared/domain/set-composition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (type: string, id: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId: id,
  resourceType: `commerce.catalog.${type}`,
  tenantId,
});
const compositionRef = ref('set-composition', '55555555-5555-4555-8555-555555555555');
const unitRef = ref('product-unit', '44444444-4444-4444-8444-444444444444');
const setProductRef = ref('product', '22222222-2222-4222-8222-222222222222');
const setVariantRef = ref('variant', '33333333-3333-4333-8333-333333333333');
const bracketSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: ref('product', '66666666-6666-4666-8666-666666666666'),
  variantRef: ref('variant', '77777777-7777-4777-8777-777777777777'),
});
const otherBracketSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: ref('product', '88888888-8888-4888-8888-888888888888'),
  variantRef: ref('variant', '99999999-9999-4999-8999-999999999999'),
});
const firstNeed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondNeed = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const r1 = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
  components: [
    { componentId: firstNeed, quantity: { amount: '2', unitRef }, selection: bracketSelection },
    { componentId: secondNeed, quantity: { amount: '2', unitRef }, selection: bracketSelection },
  ],
  productRef: setProductRef,
  provenance: { changeKind: 'INITIAL', evidenceRefs: ['set:initial'], reason: 'Initial two-bracket set' },
  reference: { resourceRef: compositionRef, revision: 1 },
  variantRef: setVariantRef,
});

interface RawChange {
  readonly componentId: string;
  readonly provenance: {
    readonly changeKind: SetComponentRevisionChange['provenance']['changeKind'];
    readonly evidenceRefs: readonly string[];
    readonly reason: string;
  };
  readonly quantity: {
    readonly amount: string;
    readonly unitRef: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly tenantId: string;
    };
  };
  readonly reference: {
    readonly resourceRef: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly tenantId: string;
    };
    readonly revision: number;
  };
  readonly selection: CatalogSelection;
}
const baseChange: RawChange = {
  componentId: firstNeed,
  provenance: {
    changeKind: 'MATERIAL_CHANGE',
    evidenceRefs: ['change:bracket-b'],
    reason: 'Bracket B replaces bracket A',
  },
  quantity: { amount: '2', unitRef },
  reference: { resourceRef: compositionRef, revision: 2 },
  selection: otherBracketSelection,
};
const change = (overrides: Partial<RawChange> = {}): SetComponentRevisionChange =>
  Schema.decodeUnknownSync(SetComponentRevisionChangeSchema)({ ...baseChange, ...overrides });

const proofFor = (
  component: SetComponent,
  variantLifecycle: SetComponentCurrentProof['variantLifecycle'],
): SetComponentCurrentProof => ({
  assessedAt: '2026-09-18T00:00:00.000Z',
  attestationId: `catalog-current:${component.componentId}`,
  componentId: component.componentId,
  divisible: false,
  productKind: 'ATOMIC',
  productLifecycle: 'ACTIVE',
  quantityStep: '1',
  quantityUnitRef: component.quantity.unitRef,
  selection: component.selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  status: 'VALID',
  variantLifecycle,
  variantProductRef: component.selection.productRef,
});

describe('Set composition revision and component replacement', () => {
  it('replaces one named need with an exact new Selection and keeps old R1 distinguishable', () => {
    const outcome = replaceSetComponent(r1, change());
    expect(outcome.status).toBe('CHANGED');
    if (outcome.status !== 'CHANGED') {
      throw new Error('Replacement must succeed');
    }
    const { revision: r2 } = outcome;
    expect(r2.reference.revision).toBe(2);
    expect(r2.predecessor).toEqual(r1.reference);
    expect(r2.components[0]?.selection).toEqual(otherBracketSelection);
    expect(r2.components[0]?.quantity.amount).toBe('2');
    expect(r2.components[1]?.selection).toEqual(bracketSelection);
    expect(classifySetCompositionChange(r1, r2)).toBe('MATERIAL_CHANGE');
    // The accepted revision and its exact goods are never repointed by building a successor.
    expect(r1.reference.revision).toBe(1);
    expect(r1.components[0]?.selection).toEqual(bracketSelection);
    expect(Result.getOrThrow(summarizeSetComponents(r1.components, '1'))).toMatchObject([{ amount: '4' }]);
  });

  it('treats a component count change as a material revision at the same name and price', () => {
    const r2 = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
      components: [
        { componentId: firstNeed, quantity: { amount: '2', unitRef }, selection: bracketSelection },
        { componentId: secondNeed, quantity: { amount: '2', unitRef }, selection: bracketSelection },
        {
          componentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          quantity: { amount: '1', unitRef },
          selection: otherBracketSelection,
        },
      ],
      predecessor: r1.reference,
      productRef: setProductRef,
      provenance: { changeKind: 'MATERIAL_CHANGE', evidenceRefs: ['set:third'], reason: 'Third component added' },
      reference: { resourceRef: compositionRef, revision: 2 },
      variantRef: setVariantRef,
    });
    expect(classifySetCompositionChange(r1, r2)).toBe('MATERIAL_CHANGE');
    expect(replaceSetComponent(r1, change({ componentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }))).toMatchObject({
      code: 'SET_COMPONENT_NOT_RECORDED',
      status: 'REJECTED',
    });
  });

  it('keeps a successor in the same Product and Variant but not as an automatic substitute', () => {
    const outcome = replaceSetComponent(r1, change());
    if (outcome.status !== 'CHANGED') {
      throw new Error('Replacement must succeed');
    }
    const { revision: r2 } = outcome;
    expect(r2.productRef).toEqual(r1.productRef);
    expect(r2.variantRef).toEqual(r1.variantRef);
    expect(r2.reference).not.toEqual(r1.reference);
    expect(classifySetCompositionChange(r1, r2)).toBe('MATERIAL_CHANGE');
    // An accepted R1 selection still carries exactly R1; only an explicit choice can move to R2.
    const accepted: CatalogSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      productRef: setProductRef,
      setComposition: r1.reference,
      variantRef: setVariantRef,
    });
    expect(accepted.setComposition).toEqual(r1.reference);
    expect(accepted.setComposition).not.toEqual(r2.reference);
  });

  it('does not let a different composition Resource or revision number impersonate a successor', () => {
    expect(replaceSetComponent(r1, change({ reference: { resourceRef: compositionRef, revision: 3 } }))).toMatchObject({
      code: 'SET_REVISION_NOT_SUCCESSOR',
      status: 'REJECTED',
    });
    expect(
      replaceSetComponent(
        r1,
        change({
          reference: { resourceRef: ref('set-composition', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), revision: 2 },
        }),
      ),
    ).toMatchObject({ code: 'SET_REVISION_NOT_SUCCESSOR', status: 'REJECTED' });
  });

  it('allows only an evidenced material change to replace a component', () => {
    expect(
      replaceSetComponent(
        r1,
        change({
          provenance: { changeKind: 'EVIDENCE_CORRECTION', evidenceRefs: ['x'], reason: 'Not a replacement' },
        }),
      ),
    ).toMatchObject({ code: 'SET_REVISION_KIND_INVALID', status: 'REJECTED' });
    expect(
      replaceSetComponent(
        r1,
        change({ provenance: { changeKind: 'MATERIAL_CHANGE', evidenceRefs: [], reason: 'No evidence' } }),
      ),
    ).toMatchObject({ code: 'SET_REVISION_PROVENANCE_INVALID', status: 'REJECTED' });
    expect(replaceSetComponent(r1, change({ selection: bracketSelection }))).toMatchObject({
      code: 'SET_COMPONENT_UNCHANGED',
      status: 'REJECTED',
    });
  });

  it('rejects a replacement that would nest the Set inside itself', () => {
    const nested = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      productRef: setProductRef,
      variantRef: ref('variant', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    });
    expect(replaceSetComponent(r1, change({ selection: nested }))).toMatchObject({
      code: 'SET_REVISION_SELECTION_INVALID',
      status: 'REJECTED',
    });
  });

  it('corrects a recorded quantity only as an evidenced successor that preserves the original', () => {
    const outcome = correctSetComponentEvidence(
      r1,
      change({
        provenance: {
          changeKind: 'EVIDENCE_CORRECTION',
          evidenceRefs: ['original-data-error:source-record-42'],
          reason: 'Source recorded two brackets; the set held three',
        },
        quantity: { amount: '3', unitRef },
        selection: bracketSelection,
      }),
    );
    expect(outcome.status).toBe('CHANGED');
    if (outcome.status !== 'CHANGED') {
      throw new Error('Correction must succeed');
    }
    expect(outcome.revision.components[0]?.quantity.amount).toBe('3');
    expect(outcome.revision.components[0]?.selection).toEqual(bracketSelection);
    expect(classifySetCompositionChange(r1, outcome.revision)).toBe('EVIDENCE_CORRECTION');
    // The used R1 keeps its original recorded error as immutable history.
    expect(r1.components[0]?.quantity.amount).toBe('2');
  });

  it('refuses a correction without original-data-error evidence or with changed goods', () => {
    const correction = (provenance: RawChange['provenance'], selection = bracketSelection) =>
      correctSetComponentEvidence(r1, change({ provenance, quantity: { amount: '3', unitRef }, selection }));
    expect(
      correction({ changeKind: 'EVIDENCE_CORRECTION', evidenceRefs: ['source-record-42'], reason: 'Count' }),
    ).toMatchObject({ code: 'SET_REVISION_PROVENANCE_INVALID', status: 'REJECTED' });
    expect(
      correction(
        { changeKind: 'EVIDENCE_CORRECTION', evidenceRefs: ['original-data-error:source-42'], reason: 'Count' },
        otherBracketSelection,
      ),
    ).toMatchObject({ code: 'SET_REVISION_SELECTION_INVALID', status: 'REJECTED' });
  });

  it('revalidates a replaced revision through the existing #466 component validation', () => {
    const outcome = replaceSetComponent(r1, change());
    if (outcome.status !== 'CHANGED') {
      throw new Error('Replacement must succeed');
    }
    const [replaced, kept] = outcome.revision.components;
    if (replaced === undefined || kept === undefined) {
      throw new Error('Replacement must keep two components');
    }
    expect(
      validateSetComponents(outcome.revision, [proofFor(replaced, 'ACTIVE'), proofFor(kept, 'ACTIVE')]),
    ).toMatchObject({ status: 'VALID' });
    // Replacing the component does not bypass Current lifecycle revalidation from #466.
    expect(
      validateSetComponents(outcome.revision, [proofFor(replaced, 'RETIRED'), proofFor(kept, 'ACTIVE')]),
    ).toMatchObject({
      code: 'COMPONENT_RETIRED_OR_INACTIVE',
      componentId: replaced.componentId,
      status: 'INVALID',
    });
  });
});
