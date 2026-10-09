import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import type { MeasuredConstraint } from '../../shared/domain/configuration-constraints.ts';
import { validateConfigurationSelection } from '../../shared/domain/configuration-selection-validator.ts';
import type { ConfigurationValidationBasis } from '../../shared/domain/configuration-selection-validator.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
} from '../../shared/domain/product-configuration.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(CatalogResourceRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType,
    tenantId,
  });
const productRef = Schema.decodeUnknownSync(ProductRefSchema)(
  ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222'),
);
const variantRef = Schema.decodeUnknownSync(VariantRefSchema)(
  ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333'),
);
const unitRef = ref('commerce.catalog.unit', '44444444-4444-4444-8444-444444444444');
const definition: ProductConfigurationDefinitionRevision = {
  choices: [
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      meaning: 'Mount',
      options: [
        { label: 'A', meaning: 'A component', optionKey: 'A' },
        { label: 'B', meaning: 'B component', optionKey: 'B' },
      ],
      required: true,
    },
    { choiceKey: 'length', kind: 'MEASURED_VALUE', meaning: 'Length', required: true, unitRef },
  ],
  productRef,
  reference: {
    resourceRef: ref('commerce.catalog.configuration-definition', '55555555-5555-4555-8555-555555555555'),
    revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(1),
  },
};
const selection: ProductConfiguration = {
  definition: definition.reference,
  productRef,
  values: [
    { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
    { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
  ],
  variantRef,
};
const lengthRule: MeasuredConstraint = {
  completeness: 'COMPLETE',
  maximum: { amount: '120', inclusive: true },
  minimum: { amount: '60', inclusive: true },
  revision: 1,
  ruleId: 'length-range',
  step: { amount: '1', base: '60' },
  unit: unitRef.resourceId,
};
const ruleRevisions = [
  {
    definitionRevision: definition.reference,
    kind: 'CHOICE' as const,
    ownerModuleId: 'commerce.catalog' as const,
    revision: 1,
    ruleId: 'mount',
  },
  {
    definitionRevision: definition.reference,
    kind: 'CHOICE' as const,
    ownerModuleId: 'commerce.catalog' as const,
    revision: 1,
    ruleId: 'length',
  },
  {
    definitionRevision: definition.reference,
    kind: 'MEASURED' as const,
    ownerModuleId: 'commerce.catalog' as const,
    revision: 1,
    ruleId: 'length-range',
  },
  {
    definitionRevision: definition.reference,
    kind: 'COMPATIBILITY' as const,
    ownerModuleId: 'commerce.catalog' as const,
    revision: 1,
    ruleId: 'A-max',
  },
];
const current = {
  attestationId: 'owner-attestation-1',
  definitionRevision: definition.reference,
  effectiveFrom: '2026-09-17T09:00:00.000Z',
  observedAt: '2026-09-17T10:00:00.000Z',
  ownerModuleId: 'commerce.catalog' as const,
  ruleRevisions,
  source: 'CATALOG_OWNER_CURRENT_READ' as const,
  status: 'CONFIRMED' as const,
};
const basis: ConfigurationValidationBasis = {
  assessedAt: '2026-09-17T10:00:00.000Z',
  compatibilityCompleteness: 'COMPLETE',
  compatibilityRules: [
    {
      choiceId: 'A',
      choiceKey: 'mount',
      kind: 'CHOICE_MEASURED_MAXIMUM',
      maximum: { amount: '100', inclusive: true },
      measuredKey: 'length',
      revision: 1,
      ruleId: 'A-max',
      unit: unitRef.resourceId,
    },
  ],
  current,
  definition,
  measuredRules: { length: lengthRule },
  targetCompleteness: 'COMPLETE',
  variantProductRef: productRef,
  variantRef,
};

describe('configuration selection validator', () => {
  it('validates an exact complete selection and preserves its values and revision evidence', () => {
    const before = JSON.stringify(selection);
    expect(validateConfigurationSelection(selection, basis)).toMatchObject({
      assessedAt: basis.assessedAt,
      definitionRevision: definition.reference,
      ruleRevisions,
      status: 'VALID',
    });
    expect(JSON.stringify(selection)).toBe(before);
  });

  it('distinguishes required, duplicate, unknown, and wrong-kind choices', () => {
    expect(validateConfigurationSelection({ ...selection, values: selection.values.slice(1) }, basis)).toMatchObject({
      code: 'REQUIRED_CHOICE_MISSING',
      ruleIds: ['mount'],
      status: 'INVALID',
    });
    expect(
      validateConfigurationSelection({ ...selection, values: [...selection.values, selection.values[0]] }, basis),
    ).toMatchObject({ code: 'DUPLICATE_CHOICE', status: 'INVALID' });
    expect(
      validateConfigurationSelection(
        { ...selection, values: [{ choiceKey: 'unknown', kind: 'SINGLE_CHOICE', optionKey: 'A' }] },
        basis,
      ),
    ).toMatchObject({ code: 'UNKNOWN_CHOICE', status: 'INVALID' });
    expect(
      validateConfigurationSelection(
        { ...selection, values: [{ amount: '83', choiceKey: 'mount', kind: 'MEASURED_VALUE', unitRef }] },
        basis,
      ),
    ).toMatchObject({ code: 'WRONG_VALUE_KIND', status: 'INVALID' });
  });

  it('does not round or substitute a known incompatibility', () => {
    const long = {
      ...selection,
      values: [selection.values[0], { amount: '110', choiceKey: 'length', kind: 'MEASURED_VALUE' as const, unitRef }],
    };
    expect(validateConfigurationSelection(long, basis)).toMatchObject({
      code: 'INCOMPATIBLE_COMBINATION',
      ruleIds: ['A-max'],
      status: 'INVALID',
    });
    expect(long.values[1]).toMatchObject({ amount: '110' });
    expect(
      validateConfigurationSelection(
        {
          ...selection,
          values: [selection.values[0], { amount: '83.5', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }],
        },
        basis,
      ),
    ).toMatchObject({ code: 'OFF_STEP', status: 'INVALID' });
  });

  it('rejects a Unit reference from another Tenant or resource type even when its ID matches', () => {
    for (const wrongUnit of [
      { ...unitRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      { ...unitRef, resourceType: 'commerce.catalog.product' },
    ]) {
      expect(
        validateConfigurationSelection(
          {
            ...selection,
            values: [
              selection.values[0],
              { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef: wrongUnit },
            ],
          },
          basis,
        ),
      ).toMatchObject({ code: 'INCOMPATIBLE_UNIT', ruleIds: ['length'], status: 'INVALID' });
    }
  });

  it('requires exact definition and target evidence without mistaking unknown for unrestricted', () => {
    expect(validateConfigurationSelection(selection, { ...basis, definition: null }).status).toBe('INDETERMINATE');
    expect(validateConfigurationSelection(selection, { ...basis, current: null })).toMatchObject({
      code: 'CURRENT_DEFINITION_UNVERIFIED',
      status: 'INDETERMINATE',
    });
    expect(
      validateConfigurationSelection(
        {
          ...selection,
          values: [selection.values[0], { amount: '110', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }],
        },
        { ...basis, current: null },
      ).status,
    ).toBe('INDETERMINATE');
    expect(
      validateConfigurationSelection(selection, {
        ...basis,
        current: { ...current, effectiveFrom: '2026-09-18T00:00:00.000Z' },
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      validateConfigurationSelection(selection, { ...basis, current: { ...current, effectiveTo: basis.assessedAt } })
        .status,
    ).toBe('INDETERMINATE');
    expect(
      validateConfigurationSelection(selection, {
        ...basis,
        current: { ...current, ruleRevisions: ruleRevisions.slice(0, 1) },
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      validateConfigurationSelection(selection, {
        ...basis,
        current: { ...current, ruleRevisions: ruleRevisions.filter((rule) => rule.kind !== 'CHOICE') },
      }),
    ).toMatchObject({ code: 'CURRENT_DEFINITION_UNVERIFIED', status: 'INDETERMINATE' });
    expect(
      validateConfigurationSelection(selection, {
        ...basis,
        current: {
          ...current,
          ruleRevisions: ruleRevisions.map((rule) =>
            rule.ruleId === 'length-range' ? { ...rule, revision: 2 } : rule,
          ),
        },
      }).status,
    ).toBe('INDETERMINATE');
    expect(validateConfigurationSelection(selection, { ...basis, variantProductRef: null }).status).toBe(
      'INDETERMINATE',
    );
    expect(validateConfigurationSelection(selection, { ...basis, measuredRules: {} }).status).toBe('INDETERMINATE');
    expect(validateConfigurationSelection(selection, { ...basis, compatibilityCompleteness: 'UNKNOWN' }).status).toBe(
      'INDETERMINATE',
    );
    expect(
      validateConfigurationSelection(selection, {
        ...basis,
        compatibilityCompleteness: 'UNKNOWN',
        compatibilityRules: basis.compatibilityRules,
        measuredRules: {},
        variantProductRef: null,
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      validateConfigurationSelection(
        {
          ...selection,
          variantRef: Schema.decodeUnknownSync(VariantRefSchema)(
            ref('commerce.catalog.variant', '66666666-6666-4666-8666-666666666666'),
          ),
        },
        basis,
      ).status,
    ).toBe('INDETERMINATE');
  });

  it('requires exact package presence and identity', () => {
    const packageRef = ref('commerce.catalog.package-definition', '77777777-7777-4777-8777-777777777777');
    expect(validateConfigurationSelection(selection, { ...basis, packageOptionRef: packageRef })).toMatchObject({
      code: 'PACKAGE_TARGET_MISMATCH',
      status: 'INVALID',
    });
    expect(validateConfigurationSelection({ ...selection, packageOptionRef: packageRef }, basis)).toMatchObject({
      code: 'PACKAGE_TARGET_MISMATCH',
      status: 'INVALID',
    });
    expect(
      validateConfigurationSelection(
        { ...selection, packageOptionRef: packageRef },
        { ...basis, packageOptionRef: packageRef, packageOptionVariantRef: variantRef },
      ).status,
    ).toBe('VALID');
  });
});
