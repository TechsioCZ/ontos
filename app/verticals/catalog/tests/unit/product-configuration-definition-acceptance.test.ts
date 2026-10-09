import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { PublishProductConfigurationPayloadSchema } from '../../shared/actions/publish-product-configuration.ts';
import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import {
  classifyConfigurationChoiceKind,
  configurationChoiceKindMeaning,
  inspectProductConfigurationDefinitionOwnership,
  OUT_OF_SCOPE_CONFIGURATION_CHOICE_KINDS,
  PRODUCT_CONFIGURATION_DEFINITION_RESOURCE_TYPE,
  SUPPORTED_CONFIGURATION_CHOICE_KINDS,
} from '../../shared/domain/configuration-definition.ts';
import { ProductConfigurationSchema } from '../../shared/domain/product-form-separation.ts';
import {
  inspectConfigurationDefinition,
  inspectProductConfiguration,
  sameProductConfigurationSelection,
  sameProductConfigurationSelectionAcrossRevisions,
} from '../../shared/domain/product-configuration.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
} from '../../shared/domain/product-configuration.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const makeRef = (resourceType: string, resourceId: string, tenant = tenantId) =>
  Schema.decodeUnknownSync(CatalogResourceRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType,
    tenantId: tenant,
  });
const productRef = Schema.decodeUnknownSync(ProductRefSchema)(
  makeRef('commerce.catalog.product', '22222222-2222-4222-8222-222222222222'),
);
const whiteVariant = Schema.decodeUnknownSync(VariantRefSchema)(
  makeRef('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333'),
);
const blackVariant = Schema.decodeUnknownSync(VariantRefSchema)(
  makeRef('commerce.catalog.variant', '44444444-4444-4444-8444-444444444444'),
);
const unitRef = makeRef('commerce.catalog.unit', '55555555-5555-4555-8555-555555555555');
const otherUnitRef = makeRef('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666');
const definitionRef = makeRef('commerce.catalog.configuration-definition', '77777777-7777-4777-8777-777777777777');
const definition: ProductConfigurationDefinitionRevision = {
  choices: [
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      meaning: 'Mounting component',
      options: [
        { label: 'A', meaning: 'Component A', optionKey: 'A' },
        { label: 'B', meaning: 'Component B', optionKey: 'B' },
      ],
      required: true,
    },
    { choiceKey: 'length', kind: 'MEASURED_VALUE', meaning: 'Cut length', required: true, unitRef },
    {
      choiceKey: 'finish',
      kind: 'SINGLE_CHOICE',
      meaning: 'Optional finish',
      options: [{ label: 'None', meaning: 'No finish', optionKey: 'none' }],
      required: false,
    },
  ],
  productRef,
  reference: {
    resourceRef: definitionRef,
    revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(1),
  },
};
const selected: ProductConfiguration = {
  definition: definition.reference,
  productRef,
  values: [
    { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
    { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
  ],
  variantRef: whiteVariant,
};

describe('Product Configuration definition acceptance (#456)', () => {
  it('distinguishes the Product-level Definition Resource from the Configuration value it validates', () => {
    expect(PRODUCT_CONFIGURATION_DEFINITION_RESOURCE_TYPE).toBe(definitionRef.resourceType);
    expect(inspectProductConfigurationDefinitionOwnership(definition).status).toBe('VALID');
    expect(inspectConfigurationDefinition(definition).status).toBe('VALID');
    expect(inspectProductConfiguration(selected, definition).status).toBe('VALID');

    const configuration = Schema.decodeUnknownSync(ProductConfigurationSchema, { onExcessProperty: 'error' })({
      kind: 'PRODUCT_CONFIGURATION',
      target: { kind: 'VARIANT', variantRef: whiteVariant },
      values: { length: { unit: 'cm', value: 83 } },
    });
    expect(configuration.target).toEqual({ kind: 'VARIANT', variantRef: whiteVariant });
    expect(() =>
      Schema.decodeUnknownSync(ProductConfigurationSchema, { onExcessProperty: 'error' })({
        kind: 'PRODUCT_CONFIGURATION',
        resourceId: definitionRef.resourceId,
        target: { kind: 'VARIANT', variantRef: whiteVariant },
        values: {},
      }),
    ).toThrow();
  });

  it('requires the Definition to be the Catalog-owned Product-level Resource at one exact revision', () => {
    expect(
      inspectProductConfigurationDefinitionOwnership({
        ...definition,
        reference: {
          ...definition.reference,
          resourceRef: makeRef('commerce.catalog.product-configuration-definition', definitionRef.resourceId),
        },
      }),
    ).toMatchObject({ status: 'INVALID' });

    const wrongType = {
      ...definition,
      reference: {
        ...definition.reference,
        resourceRef: makeRef('commerce.catalog.product', definitionRef.resourceId),
      },
    };
    expect(inspectConfigurationDefinition(wrongType)).toMatchObject({ status: 'INVALID' });

    const foreignProduct = Schema.decodeUnknownSync(ProductRefSchema)({
      ...productRef,
      tenantId: otherTenantId,
    });
    expect(inspectConfigurationDefinition({ ...definition, productRef: foreignProduct })).toMatchObject({
      status: 'INVALID',
    });

    expect(
      inspectProductConfigurationDefinitionOwnership({
        productRef,
        reference: { resourceRef: definitionRef, revision: 0 },
      }),
    ).toMatchObject({ status: 'INVALID' });
  });

  it('keeps each choice meaning Product-owned, so identical labels alone prove no shared choice', () => {
    const secondDefinition: ProductConfigurationDefinitionRevision = {
      ...definition,
      reference: {
        ...definition.reference,
        resourceRef: makeRef('commerce.catalog.configuration-definition', otherUnitRef.resourceId),
      },
    };
    const secondSelection: ProductConfiguration = { ...selected, definition: secondDefinition.reference };
    expect(
      sameProductConfigurationSelectionAcrossRevisions(selected, definition, secondSelection, secondDefinition),
    ).toMatchObject({ status: 'INDETERMINATE' });
  });

  it('accepts exactly one explicit Single Choice value and supports optional absence', () => {
    expect(classifyConfigurationChoiceKind('SINGLE_CHOICE')).toMatchObject({
      kind: 'SINGLE_CHOICE',
      status: 'SUPPORTED',
    });
    expect(configurationChoiceKindMeaning.SINGLE_CHOICE).toContain('Exactly one value');
    expect(inspectProductConfiguration(selected, definition).status).toBe('VALID');
    expect(inspectProductConfiguration({ ...selected, values: selected.values.slice(1) }, definition)).toMatchObject({
      reason: 'Required choice is missing',
      status: 'INVALID',
    });
    expect(
      inspectProductConfiguration({ ...selected, values: [...selected.values, selected.values[0]] }, definition),
    ).toMatchObject({ status: 'INVALID' });
    expect(
      inspectProductConfiguration(
        {
          ...selected,
          values: [
            selected.values[0],
            { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'missing' },
            selected.values[1],
          ],
        },
        definition,
      ),
    ).toMatchObject({ status: 'INVALID' });
  });

  it('keeps a Measured Value as one exact number with the declared Unit, never a fixed Variant', () => {
    expect(classifyConfigurationChoiceKind('MEASURED_VALUE')).toMatchObject({
      kind: 'MEASURED_VALUE',
      status: 'SUPPORTED',
    });
    expect(configurationChoiceKindMeaning.MEASURED_VALUE).toContain('exact numeric value');
    const individual: ProductConfiguration = {
      ...selected,
      values: [selected.values[0], { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }],
    };
    expect(inspectProductConfiguration(individual, definition).status).toBe('VALID');
    expect(
      inspectProductConfiguration(
        {
          ...selected,
          values: [
            selected.values[0],
            { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef: otherUnitRef },
          ],
        },
        definition,
      ),
    ).toMatchObject({ status: 'INDETERMINATE' });
    expect(
      inspectProductConfiguration(
        {
          ...selected,
          values: [
            selected.values[0],
            { amount: 'not-a-number', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
          ],
        },
        definition,
      ),
    ).toMatchObject({ status: 'INVALID' });
    expect(inspectProductConfiguration(individual, definition)).not.toHaveProperty('resourceId');
  });

  it('rejects out-of-scope and unrecognized choice kinds fail-closed', () => {
    expect(SUPPORTED_CONFIGURATION_CHOICE_KINDS).toEqual(['MEASURED_VALUE', 'SINGLE_CHOICE']);
    for (const kind of OUT_OF_SCOPE_CONFIGURATION_CHOICE_KINDS) {
      expect(classifyConfigurationChoiceKind(kind)).toMatchObject({
        code: 'OUT_OF_SCOPE_CHOICE_KIND',
        kind,
        status: 'UNSUPPORTED',
      });
    }
    expect(classifyConfigurationChoiceKind('multi_choice')).toMatchObject({ code: 'UNKNOWN_CHOICE_KIND' });

    const payload = {
      choices: [
        {
          choiceKey: 'mount',
          kind: 'SINGLE_CHOICE',
          label: 'Mount',
          meaning: 'Mounting component',
          options: [{ label: 'A', meaning: 'Component A', optionKey: 'A' }],
          required: true,
        },
      ],
      compatibilityRules: [],
      definitionId: 'definition-1',
      effectiveFrom: new Date('2026-09-17T00:00:00.000Z'),
      evidenceRefs: ['evidence-1'],
      expectedRevision: 0,
      measuredRules: [],
      optionAllowances: [{ allowed: true, choiceKey: 'mount', evidenceRefs: ['evidence-1'], optionKey: 'A' }],
      productId: 'product-1',
      reason: 'publish',
    };
    expect(Schema.decodeUnknownSync(PublishProductConfigurationPayloadSchema)(payload)).toMatchObject({
      definitionId: 'definition-1',
    });
    expect(() =>
      Schema.decodeUnknownSync(PublishProductConfigurationPayloadSchema)({
        ...payload,
        choices: [{ ...payload.choices[0], kind: 'FREE_TEXT' }],
      }),
    ).toThrow();
  });

  it('keeps a Variant as the exact target identity while admissibility remains Variant-specific', () => {
    expect(inspectProductConfiguration(selected, definition).status).toBe('VALID');
    expect(inspectProductConfiguration({ ...selected, variantRef: blackVariant }, definition).status).toBe('VALID');
    expect(
      sameProductConfigurationSelection(selected, { ...selected, variantRef: blackVariant }, definition),
    ).toMatchObject({ same: false, status: 'VALID' });
    const lengthChoice = definition.choices.find((choice) => choice.choiceKey === 'length');
    expect(lengthChoice).not.toHaveProperty('variantRef');
    expect(lengthChoice).not.toHaveProperty('variantId');
  });

  it('is a product-complete value that still confirms no other business decision', () => {
    const inspection = inspectProductConfiguration(selected, definition);
    expect(Object.keys(inspection)).toEqual(['status']);
    expect(new Set(Object.keys(selected))).toEqual(new Set(['definition', 'productRef', 'values', 'variantRef']));
    for (const unrelated of ['assortment', 'availability', 'inventory', 'order', 'permission', 'price']) {
      expect(selected).not.toHaveProperty(unrelated);
    }
  });
});
