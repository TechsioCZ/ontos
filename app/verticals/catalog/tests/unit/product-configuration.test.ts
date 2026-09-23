import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import {
  inspectConfigurationDefinition,
  inspectProductConfigurationCurrentActivation,
  inspectProductConfiguration,
  sameProductConfigurationSelection,
  sameProductConfigurationSelectionAcrossRevisions,
} from '../../shared/domain/product-configuration.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
  ProductConfigurationRevisionEquivalenceAttestation,
} from '../../shared/domain/product-configuration.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const makeRef = (resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(CatalogResourceRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType,
    tenantId,
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
const definitionRef = makeRef('commerce.catalog.configuration-definition', '66666666-6666-4666-8666-666666666666');
const definition: ProductConfigurationDefinitionRevision = {
  choices: [
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      meaning: 'Mounting component',
      options: [
        { label: 'A', meaning: 'Component A', optionKey: 'A' },
        { label: 'None', meaning: 'No mount', optionKey: 'none' },
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

describe('Product Configuration definition and identity', () => {
  it('supports only explicit Single Choice and exact Measured Value, including optional absence', () => {
    expect(inspectConfigurationDefinition(definition).status).toBe('VALID');
    expect(inspectProductConfiguration(selected, definition).status).toBe('VALID');
    expect(inspectProductConfiguration({ ...selected, values: selected.values.slice(1) }, definition).status).toBe(
      'INVALID',
    );
    expect(
      inspectProductConfiguration({ ...selected, values: [...selected.values, selected.values[0]] }, definition).status,
    ).toBe('INVALID');
    expect(
      inspectProductConfiguration(
        { ...selected, values: [...selected.values, { choiceKey: 'unknown', kind: 'SINGLE_CHOICE', optionKey: 'A' }] },
        definition,
      ).status,
    ).toBe('INVALID');
    const unavailable = new Map<string, ProductConfigurationDefinitionRevision>().get('missing');
    expect(inspectProductConfiguration(selected, unavailable).status).toBe('INDETERMINATE');
  });

  it('distinguishes exact targets and values, but ignores labels, order, and decimal spelling', () => {
    expect(
      sameProductConfigurationSelection(selected, { ...selected, variantRef: blackVariant }, definition),
    ).toMatchObject({ same: false, status: 'VALID' });
    expect(
      sameProductConfigurationSelection(
        selected,
        {
          ...selected,
          values: [selected.values[0], { amount: '84', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }],
        },
        definition,
      ),
    ).toMatchObject({ same: false, status: 'VALID' });
    expect(
      sameProductConfigurationSelection(
        selected,
        {
          ...selected,
          values: [{ amount: '83.00', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }, selected.values[0]],
        },
        definition,
      ),
    ).toMatchObject({ same: true, status: 'VALID' });
    expect(
      sameProductConfigurationSelection(
        selected,
        {
          ...selected,
          values: [...selected.values, { choiceKey: 'finish', kind: 'SINGLE_CHOICE', optionKey: 'none' }],
        },
        definition,
      ),
    ).toMatchObject({ same: false, status: 'VALID' });
  });

  it('does not infer equivalence from a changed Unit or an unavailable revision', () => {
    const millimeterRef = makeRef('commerce.catalog.unit', '77777777-7777-4777-8777-777777777777');
    expect(
      inspectProductConfiguration(
        {
          ...selected,
          values: [
            selected.values[0],
            { amount: '830', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef: millimeterRef },
          ],
        },
        definition,
      ).status,
    ).toBe('INDETERMINATE');
    expect(
      inspectProductConfiguration(
        {
          ...selected,
          definition: { ...definition.reference, revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(2) },
        },
        definition,
      ).status,
    ).toBe('INDETERMINATE');
  });

  it('requires an owner-issued exact Current activation and rule revision evidence', () => {
    const assessedAt = '2026-09-17T12:00:00.000Z';
    const activation = {
      attestationId: '88888888-8888-4888-8888-888888888888',
      definitionRevision: definition.reference,
      effectiveFrom: '2026-09-17T11:00:00.000Z',
      observedAt: assessedAt,
      ownerModuleId: 'commerce.catalog' as const,
      ruleRevisions: [
        {
          definitionRevision: definition.reference,
          kind: 'MEASURED' as const,
          ownerModuleId: 'commerce.catalog' as const,
          revision: 1,
          ruleId: 'length-range',
        },
      ],
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      status: 'CONFIRMED' as const,
    };
    expect(inspectProductConfigurationCurrentActivation(selected, definition, activation, assessedAt).status).toBe(
      'VALID',
    );
    const unavailable = new Map<string, typeof activation>().get('missing');
    expect(inspectProductConfigurationCurrentActivation(selected, definition, unavailable, assessedAt).status).toBe(
      'INDETERMINATE',
    );
    expect(
      inspectProductConfigurationCurrentActivation(
        selected,
        definition,
        { ...activation, observedAt: '2026-09-17T10:00:00.000Z' },
        assessedAt,
      ).status,
    ).toBe('INDETERMINATE');
    expect(
      inspectProductConfigurationCurrentActivation(
        selected,
        definition,
        { ...activation, effectiveTo: assessedAt },
        assessedAt,
      ).status,
    ).toBe('INDETERMINATE');
    expect(
      inspectProductConfigurationCurrentActivation(
        selected,
        definition,
        { ...activation, ruleRevisions: [{ ...activation.ruleRevisions[0], revision: 0 }] },
        assessedAt,
      ).status,
    ).toBe('INDETERMINATE');
  });

  it('fails closed across Definition revisions until Catalog attests exact meaning and admissibility', () => {
    const nextRevision = Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(2);
    const nextDefinition: ProductConfigurationDefinitionRevision = {
      ...definition,
      choices: definition.choices.map((choice) =>
        choice.kind === 'SINGLE_CHOICE'
          ? { ...choice, options: choice.options.map((option) => ({ ...option, label: `Renamed ${option.label}` })) }
          : choice,
      ),
      reference: { ...definition.reference, revision: nextRevision },
    };
    const nextSelection: ProductConfiguration = { ...selected, definition: nextDefinition.reference };
    const compare = (evidence?: ProductConfigurationRevisionEquivalenceAttestation) =>
      sameProductConfigurationSelectionAcrossRevisions(selected, definition, nextSelection, nextDefinition, evidence);
    expect(compare().status).toBe('INDETERMINATE');
    const evidence: ProductConfigurationRevisionEquivalenceAttestation = {
      admissibility: {
        completeCurrentRuleBasis: true,
        left: 'ADMISSIBLE',
        leftRuleRevisions: [
          {
            definitionRevision: definition.reference,
            kind: 'MEASURED',
            ownerModuleId: 'commerce.catalog',
            revision: 1,
            ruleId: 'length-range',
          },
        ],
        right: 'ADMISSIBLE',
        rightRuleRevisions: [
          {
            definitionRevision: nextDefinition.reference,
            kind: 'MEASURED',
            ownerModuleId: 'commerce.catalog',
            revision: 2,
            ruleId: 'length-range',
          },
        ],
      },
      attestationId: '88888888-8888-4888-8888-888888888888',
      leftSelection: selected,
      meaning: { choicesAndValues: 'SAME', units: 'SAME' },
      ownerModuleId: 'commerce.catalog',
      rightSelection: nextSelection,
      source: 'CATALOG_OWNER_EQUIVALENCE_ASSESSMENT',
      status: 'CONFIRMED',
    };
    expect(compare(evidence)).toMatchObject({ same: true, status: 'VALID' });
    const wrongOwner = structuredClone(evidence);
    Reflect.set(wrongOwner, 'ownerModuleId', 'other');
    expect(compare(wrongOwner).status).toBe('INDETERMINATE');
    const incompleteRules = structuredClone(evidence);
    Reflect.set(incompleteRules.admissibility, 'completeCurrentRuleBasis', false);
    expect(compare(incompleteRules).status).toBe('INDETERMINATE');
    expect(compare({ ...evidence, rightSelection: { ...nextSelection, variantRef: blackVariant } }).status).toBe(
      'INDETERMINATE',
    );
    expect(
      compare({
        ...evidence,
        admissibility: { ...evidence.admissibility, rightRuleRevisions: evidence.admissibility.leftRuleRevisions },
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      sameProductConfigurationSelectionAcrossRevisions(
        selected,
        definition,
        { ...nextSelection, variantRef: blackVariant },
        nextDefinition,
        evidence,
      ),
    ).toMatchObject({ same: false, status: 'VALID' });
    expect(
      sameProductConfigurationSelectionAcrossRevisions(
        selected,
        definition,
        {
          ...nextSelection,
          values: [{ ...selected.values[0] }, { amount: '84', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef }],
        },
        nextDefinition,
        evidence,
      ).status,
    ).toBe('INDETERMINATE');
  });
});
