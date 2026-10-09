import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogAcceptedSelectionEvidenceSchema,
  CatalogSelectionAssessmentResultSchema,
  CatalogSelectionBasisSchema,
  CatalogSelectionEvidenceSchema,
  CatalogSelectionSchema,
  CatalogSelectionWithQuantitySchema,
  ProductSelectionRevisionSchema,
  sameCatalogSelectionBasis,
} from '../../shared/domain/catalog-selection-evidence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string, scopedTenantId = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: scopedTenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const typeRef = ref('commerce.catalog.product-type', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const typeProof = { role: 'PRODUCT_TYPE', source: { resourceRef: typeRef, revision: 1 } };
const selection = { productRef, variantRef };
const instant = '2026-09-17T12:00:00.000Z';
const decodeSelection = Schema.decodeUnknownSync(CatalogSelectionSchema, { onExcessProperty: 'error' });
const decodeEvidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema, { onExcessProperty: 'error' });

describe('Catalog Selection decision references', () => {
  it('keeps component dependency roles and subjects distinct without fabricating revision identity', () => {
    const composition = {
      resourceRef: ref('commerce.catalog.set-composition', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      revision: 2,
    };
    const componentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const subject = { componentId, composition, kind: 'SET_COMPONENT' };
    const source = { resourceRef: variantRef, revision: 3 };
    const decode = Schema.decodeUnknownSync(CatalogSelectionBasisSchema, { onExcessProperty: 'error' });
    const divisibility = decode({ role: 'UNIT_TARGET_DIVISIBILITY', source, subject });
    const variant = decode({ role: 'VARIANT', source, subject });
    expect(divisibility.subject).toMatchObject(subject);
    expect(divisibility.source).toMatchObject(source);
    expect(divisibility.source.revisionId).toBeUndefined();
    expect(sameCatalogSelectionBasis(divisibility, variant)).toBe(false);
    expect(
      sameCatalogSelectionBasis(
        divisibility,
        decode({ role: 'UNIT_TARGET_DIVISIBILITY', source, subject: { ...subject, componentId: tenantId } }),
      ),
    ).toBe(false);
    expect(() => decode({ role: 'UNIT_RULE', source: { ...source, resourceRef: variantRef }, subject })).toThrow();
    expect(() => decode({ role: 'PACKAGE_OPTION_ROLE', source, subject })).toThrow();
  });

  it('rejects duplicate component basis identity and facts scoped to a different composition', () => {
    const composition = {
      resourceRef: ref('commerce.catalog.set-composition', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      revision: 2,
    };
    const subject = { componentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', composition, kind: 'SET_COMPONENT' };
    const componentFact = { role: 'VARIANT', source: { resourceRef: variantRef, revision: 3 }, subject };
    const membership = {
      attestationId: 'catalog-membership-1',
      observedAt: instant,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 2 },
    };
    const basis = [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT', source: membership.variant },
      typeProof,
      { role: 'SET_COMPOSITION', source: composition },
      componentFact,
    ];
    const selected = { ...selection, setComposition: composition };
    const evidence = {
      assessedAt: instant,
      basis,
      membership,
      purpose: 'PURCHASE_ACCEPTANCE',
      selection: selected,
      status: 'VALID',
    };
    expect(decodeEvidence(evidence)).toMatchObject({ status: 'VALID' });
    expect(() => decodeEvidence({ ...evidence, basis: [...basis, componentFact] })).toThrow();
    expect(() =>
      decodeEvidence({
        ...evidence,
        basis: basis.map((fact) =>
          fact === componentFact
            ? { ...componentFact, subject: { ...subject, composition: { ...composition, revision: 3 } } }
            : fact,
        ),
      }),
    ).toThrow();
    expect(() => decodeEvidence({ ...evidence, basis: basis.filter((fact) => fact.role !== 'PRODUCT') })).toThrow();
  });
  it('keeps exact Product and Variant identity without inventing a revision ID', () => {
    expect(decodeSelection(selection)).toMatchObject(selection);
    expect(
      Schema.decodeUnknownSync(ProductSelectionRevisionSchema)({ resourceRef: productRef, revision: 1 }),
    ).toMatchObject({
      resourceRef: productRef,
      revision: 1,
    });
    expect(() =>
      Schema.decodeUnknownSync(ProductSelectionRevisionSchema)({ resourceRef: variantRef, revision: 1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProductSelectionRevisionSchema)({ resourceRef: productRef, revision: 'latest' }),
    ).toThrow();
    expect(() => decodeSelection({ productRef })).toThrow();
    expect(() =>
      decodeSelection({
        ...selection,
        variantRef: { ...variantRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow();
  });

  it('pins package content and set composition without accepting a successor silently', () => {
    const packageRef = ref('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
    const setRef = ref('commerce.catalog.set-composition', '55555555-5555-4555-8555-555555555555');
    const packedSet = {
      ...selection,
      packageOption: { contentRevision: { resourceRef: packageRef, revision: 1 }, optionRef: packageRef },
      setComposition: { resourceRef: setRef, revision: 1 },
    };
    expect(decodeSelection(packedSet)).toMatchObject(packedSet);
    expect(
      decodeSelection({
        ...packedSet,
        packageOption: { ...packedSet.packageOption, contentRevision: { resourceRef: packageRef, revision: 2 } },
      }),
    ).not.toEqual(decodeSelection(packedSet));
    expect(() =>
      decodeSelection({
        ...packedSet,
        packageOption: { contentRevision: { resourceRef: setRef, revision: 1 }, optionRef: packageRef },
      }),
    ).toThrow();
    expect(() =>
      decodeSelection({
        ...packedSet,
        setComposition: {
          resourceRef: ref(
            'commerce.catalog.set-composition',
            setRef.resourceId,
            '99999999-9999-4999-8999-999999999999',
          ),
          revision: 1,
        },
      }),
    ).toThrow();
  });

  it('keeps Configuration as a value and Quantity separate from package contents', () => {
    const definition = ref('commerce.catalog.configuration-definition', '66666666-6666-4666-8666-666666666666');
    const attribute = ref('commerce.catalog.attribute-definition', '77777777-7777-4777-8777-777777777777');
    const configured = {
      ...selection,
      configuration: {
        choices: [{ attributeDefinition: { resourceRef: attribute, revision: 3 }, choiceKey: 'length', value: '83' }],
        definition: { resourceRef: definition, revision: 1 },
        productRef,
        variantRef,
      },
    };
    const line = {
      quantity: { amount: '2', unitRef: ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888') },
      selection: configured,
    };
    expect(Schema.decodeUnknownSync(CatalogSelectionWithQuantitySchema)(line)).toMatchObject(line);
    expect(() => decodeSelection({ ...configured, configurationRef: definition })).toThrow();
    expect(() =>
      decodeSelection({
        ...configured,
        configuration: {
          ...configured.configuration,
          variantRef: ref('commerce.catalog.variant', '99999999-9999-4999-8999-999999999999'),
        },
      }),
    ).toThrow();
    expect(
      decodeSelection({
        ...configured,
        configuration: {
          ...configured.configuration,
          choices: [{ choiceKey: 'length', unit: { resourceRef: line.quantity.unitRef, revision: 4 }, value: '83' }],
        },
      }),
    ).toBeDefined();
    expect(() =>
      decodeSelection({
        ...configured,
        configuration: {
          ...configured.configuration,
          choices: [{ choiceKey: 'length', unit: { resourceRef: definition, revision: 4 }, value: '83' }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeSelection({
        ...configured,
        configuration: {
          ...configured.configuration,
          choices: [...configured.configuration.choices, ...configured.configuration.choices],
        },
      }),
    ).toThrow();
  });

  it('distinguishes invalid, indeterminate, unavailable and historical accepted evidence', () => {
    const membership = {
      attestationId: 'catalog-membership-1',
      observedAt: instant,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 2 },
    };
    const basis = [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT', source: membership.variant },
      typeProof,
    ];
    const purpose = 'PURCHASE_ACCEPTANCE';
    expect(
      decodeEvidence({ assessedAt: instant, basis, membership, purpose, selection, status: 'VALID' }),
    ).toMatchObject({
      status: 'VALID',
    });
    expect(() => decodeEvidence({ assessedAt: instant, basis, purpose, selection, status: 'VALID' })).toThrow();
    expect(() =>
      decodeEvidence({
        assessedAt: instant,
        basis,
        membership: { ...membership, observedAt: '2026-09-16T12:00:00.000Z' },
        purpose,
        selection,
        status: 'VALID',
      }),
    ).toThrow();
    expect(() =>
      decodeEvidence({
        assessedAt: instant,
        basis,
        membership: { ...membership, variant: { resourceRef: variantRef, revision: 3 } },
        purpose,
        selection,
        status: 'VALID',
      }),
    ).toThrow();
    expect(
      decodeEvidence({ assessedAt: instant, basis, purpose, reason: 'Retired Variant', selection, status: 'INVALID' }),
    ).toMatchObject({ status: 'INVALID' });
    expect(
      decodeEvidence({
        assessedAt: instant,
        basis,
        purpose,
        reason: 'Type unavailable',
        selection,
        status: 'INDETERMINATE',
      }),
    ).toMatchObject({ status: 'INDETERMINATE' });
    expect(
      Schema.decodeUnknownSync(CatalogSelectionAssessmentResultSchema)({
        kind: 'UNAVAILABLE',
        reason: 'Owner offline',
      }),
    ).toMatchObject({ kind: 'UNAVAILABLE' });
    expect(() =>
      decodeEvidence({
        assessedAt: instant,
        basis,
        kind: 'UNAVAILABLE',
        membership,
        purpose,
        selection,
        status: 'VALID',
      }),
    ).toThrow();
    const accepted = {
      acceptedAt: instant,
      acceptedSelection: {
        quantity: { amount: '1', unitRef: ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888') },
        selection,
      },
      basis,
      historical: true,
      purpose,
    };
    expect(Schema.decodeUnknownSync(CatalogAcceptedSelectionEvidenceSchema)(accepted)).toMatchObject(accepted);
    expect(() =>
      Schema.decodeUnknownSync(CatalogAcceptedSelectionEvidenceSchema)({ ...accepted, historical: false }),
    ).toThrow();
  });

  it('requires exactly one typed or confirmed-untyped proof for VALID evidence', () => {
    const membership = {
      attestationId: 'catalog-membership-untyped-1',
      observedAt: instant,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 2 },
    };
    const directBasis = [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT', source: membership.variant },
    ];
    const untypedProof = {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 7 },
    };
    const evidence = {
      assessedAt: instant,
      basis: [...directBasis, untypedProof],
      membership,
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
      status: 'VALID',
    };
    expect(decodeEvidence(evidence).basis).toContainEqual(untypedProof);
    expect(() =>
      decodeEvidence({
        ...evidence,
        basis: [
          ...evidence.basis,
          {
            role: 'PRODUCT_TYPE',
            source: { resourceRef: ref('commerce.catalog.product-type', tenantId), revision: 1 },
          },
        ],
      }),
    ).toThrow();
    expect(() => decodeEvidence({ ...evidence, basis: directBasis })).toThrow();
    expect(() =>
      decodeEvidence({
        ...evidence,
        basis: [{ role: 'PRODUCT_TYPE_UNTYPED_DECISION', source: untypedProof.source }, ...directBasis],
      }),
    ).toThrow();
    expect(() =>
      decodeEvidence({
        ...evidence,
        basis: [
          ...directBasis,
          {
            ...untypedProof,
            source: {
              resourceRef: ref('commerce.catalog.product-type', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
              revision: 7,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects VALID evidence missing a pinned package, set, or configuration source', () => {
    const packageRef = ref('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
    const setRef = ref('commerce.catalog.set-composition', '55555555-5555-4555-8555-555555555555');
    const definitionRef = ref('commerce.catalog.configuration-definition', '66666666-6666-4666-8666-666666666666');
    const attributeRef = ref('commerce.catalog.attribute-definition', '77777777-7777-4777-8777-777777777777');
    const unitRef = ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888');
    const contentRevision = { resourceRef: packageRef, revision: 4 };
    const setComposition = { resourceRef: setRef, revision: 3 };
    const definition = { resourceRef: definitionRef, revision: 2 };
    const attributeDefinition = { resourceRef: attributeRef, revision: 5 };
    const unit = { resourceRef: unitRef, revision: 1 };
    const membership = {
      attestationId: 'catalog-membership-2',
      observedAt: instant,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 2 },
    };
    const configuredPackedSet = {
      ...selection,
      configuration: {
        choices: [{ attributeDefinition, choiceKey: 'length', unit, value: '83' }],
        definition,
        productRef,
        variantRef,
      },
      packageOption: { contentRevision, optionRef: packageRef },
      setComposition,
    };
    const directBasis = [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT', source: membership.variant },
      typeProof,
    ];
    const requiredBasis = [
      { role: 'PACKAGE_CONTENT', source: contentRevision },
      { role: 'SET_COMPOSITION', source: setComposition },
      { role: 'CONFIGURATION_DEFINITION', source: definition },
      { role: 'ATTRIBUTE_DEFINITION', source: attributeDefinition },
      { role: 'UNIT', source: unit },
    ];
    const evidence = {
      assessedAt: instant,
      basis: [...directBasis, ...requiredBasis],
      membership,
      purpose: 'PURCHASE_ACCEPTANCE',
      selection: configuredPackedSet,
      status: 'VALID',
    };
    expect(decodeEvidence(evidence)).toMatchObject(evidence);
    const choiceWithoutAttribute = {
      ...configuredPackedSet,
      configuration: {
        ...configuredPackedSet.configuration,
        choices: [{ choiceKey: 'length', unit, value: '83' }],
      },
    };
    expect(
      decodeEvidence({
        ...evidence,
        basis: evidence.basis.filter((entry) => entry.role !== 'ATTRIBUTE_DEFINITION'),
        selection: choiceWithoutAttribute,
      }),
    ).toBeDefined();
    for (const omitted of requiredBasis) {
      expect(() =>
        decodeEvidence({ ...evidence, basis: evidence.basis.filter((entry) => entry !== omitted) }),
      ).toThrow();
    }
    expect(() =>
      decodeEvidence({
        ...evidence,
        basis: [
          ...directBasis,
          ...requiredBasis.map((entry) =>
            entry.role === 'PACKAGE_CONTENT' ? { ...entry, source: { resourceRef: packageRef, revision: 5 } } : entry,
          ),
        ],
      }),
    ).toThrow();
  });

  it('qualifies every deciding basis role to its expected Catalog resourceType', () => {
    const qualifiedTypeRef = ref('commerce.catalog.product-type', '99999999-9999-4999-8999-999999999999');
    const attributeRef = ref('commerce.catalog.attribute-definition', '77777777-7777-4777-8777-777777777777');
    const valueSetRef = ref('commerce.catalog.attribute-value-set', '66666666-6666-4666-8666-666666666666');
    const definitionRef = ref('commerce.catalog.configuration-definition', '66666666-6666-4666-8666-666666666666');
    const unitRef = ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888');
    const unitRuleRef = ref('commerce.catalog.product-unit', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const packageRef = ref('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
    const setRef = ref('commerce.catalog.set-composition', '55555555-5555-4555-8555-555555555555');
    const categoryRef = ref('commerce.catalog.product-category', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const decode = Schema.decodeUnknownSync(CatalogSelectionBasisSchema, { onExcessProperty: 'error' });
    const qualified: readonly (readonly [string, object])[] = [
      ['PRODUCT', productRef],
      ['VARIANT', variantRef],
      ['PRODUCT_TYPE', qualifiedTypeRef],
      ['ATTRIBUTE_DEFINITION', attributeRef],
      ['INHERITED_VALUE', valueSetRef],
      ['VARIANT_AXIS', productRef],
      ['CONFIGURATION_DEFINITION', definitionRef],
      ['UNIT', unitRef],
      ['UNIT_CONVERSION', unitRef],
      ['UNIT_RULE', unitRuleRef],
      ['UNIT_TARGET_DIVISIBILITY', variantRef],
      ['UNIT_TARGET_DIVISIBILITY', packageRef],
      ['PACKAGE_CONTENT', packageRef],
      ['PACKAGE_OPTION_ROLE', packageRef],
      ['SET_COMPOSITION', setRef],
      ['CATEGORY', categoryRef],
    ];
    for (const [role, resourceRef] of qualified) {
      expect(decode({ role, source: { resourceRef, revision: 1 } })).toMatchObject({ role });
    }
    expect(() => decode({ role: 'PRODUCT', source: { resourceRef: variantRef, revision: 1 } })).toThrow();
    expect(() => decode({ role: 'CATEGORY', source: { resourceRef: productRef, revision: 1 } })).toThrow();
    expect(() => decode({ role: 'UNIT_CONVERSION', source: { resourceRef: productRef, revision: 1 } })).toThrow();
    expect(() => decode({ role: 'PACKAGE_CONTENT', source: { resourceRef: variantRef, revision: 1 } })).toThrow();
    expect(decode({ role: 'OTHER_CATALOG_FACT', source: { resourceRef: valueSetRef, revision: 1 } })).toMatchObject({
      role: 'OTHER_CATALOG_FACT',
    });
    expect(decode({ role: 'COMPONENT', source: { resourceRef: variantRef, revision: 1 } })).toMatchObject({
      role: 'COMPONENT',
    });
  });
});
