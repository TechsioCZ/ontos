import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
  ProductConfigurationRevisionEquivalenceAttestation,
} from '../../shared/domain/product-configuration.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { reassessProductConfigurationChange } from '../../src/domain/product-configuration-reassessment.ts';
import type { ProductConfigurationReassessmentAuthority } from '../../src/domain/product-configuration-reassessment.ts';
import type {
  CurrentConfigurationAssessment,
  CurrentConfigurationAssessmentInput,
  CurrentConfigurationValue,
} from '../../src/persistence/product-configuration-current-evaluator.ts';

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
const definitionRef = ref('commerce.catalog.configuration-definition', '55555555-5555-4555-8555-555555555555');

const definition = (revision: number, mountLabel = 'A'): ProductConfigurationDefinitionRevision => ({
  choices: [
    { choiceKey: 'length', kind: 'MEASURED_VALUE', meaning: 'Exact length', required: true, unitRef },
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      meaning: 'Mount',
      options: [
        { label: mountLabel, meaning: 'Part A', optionKey: 'A' },
        { label: 'B', meaning: 'Part B', optionKey: 'B' },
      ],
      required: true,
    },
  ],
  productRef,
  reference: {
    resourceRef: definitionRef,
    revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(revision),
  },
});
const earlierDefinition = definition(1);
const renamedDefinition = definition(2, 'Mount type A (renamed)');
const successorDefinition = definition(2);

const selection = (source: ProductConfigurationDefinitionRevision): ProductConfiguration => ({
  definition: source.reference,
  productRef,
  values: [
    { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
    { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
  ],
  variantRef,
});
const earlierSelection = selection(earlierDefinition);
const renamedSelection = selection(renamedDefinition);

const values: readonly CurrentConfigurationValue[] = [
  { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitId: unitRef.resourceId },
  { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
];
const earlierAt = new Date('2026-09-01T00:00:00.000Z');
const at = new Date('2026-09-18T12:00:00.000Z');
const target = {
  definitionId: definitionRef.resourceId,
  productId: productRef.resourceId,
  variantId: variantRef.resourceId,
};
const earlierInput: CurrentConfigurationAssessmentInput = { at: earlierAt, target, values };
const currentInput: CurrentConfigurationAssessmentInput = { at, target, values };

const choiceRevisions = (revision: number) => [
  {
    choiceKey: 'length',
    evidenceRefs: ['definition-evidence'],
    kind: 'MEASURED_VALUE' as const,
    meaning: 'Exact length',
    options: [],
    ownerModuleId: 'commerce.catalog' as const,
    required: true,
    revision,
    unitId: unitRef.resourceId,
    unitRevision: 1,
  },
  {
    choiceKey: 'mount',
    evidenceRefs: ['definition-evidence'],
    kind: 'SINGLE_CHOICE' as const,
    meaning: 'Mount',
    options: [
      { meaning: 'Part A', optionKey: 'A' },
      { meaning: 'Part B', optionKey: 'B' },
    ],
    ownerModuleId: 'commerce.catalog' as const,
    required: true,
    revision,
  },
];
const rule = (revision: number) => ({
  definitionRevision: revision,
  evidenceRefs: ['owner-evidence'],
  kind: 'MEASURED' as const,
  ownerModuleId: 'commerce.catalog' as const,
  revision,
  ruleId: 'measured:length:product:all-packages',
});
const unitRevisions = (observedAt: Date) => [
  {
    dimension: 'length',
    effectiveFrom: observedAt,
    evidenceRefs: ['unit-evidence'],
    lifecycleState: 'ACTIVE' as const,
    meaning: 'Centimetre',
    ref: unitRef,
    revision: 1,
  },
];
const validAssessment = (revision: number, observedAt: Date): CurrentConfigurationAssessment => ({
  assessedAt: observedAt,
  choiceRevisions: choiceRevisions(revision),
  definitionId: definitionRef.resourceId,
  definitionRevision: revision,
  effectiveFrom: observedAt,
  rules: [rule(revision)],
  status: 'VALID',
  target,
  unitRevisions: unitRevisions(observedAt),
});
const earlierAssessment = validAssessment(1, earlierAt);
const renamedAssessment = validAssessment(2, at);
const invalidAssessment: CurrentConfigurationAssessment = {
  assessedAt: at,
  choiceRevisions: choiceRevisions(2),
  code: 'INCOMPATIBLE_COMBINATION',
  definitionId: definitionRef.resourceId,
  definitionRevision: 2,
  effectiveFrom: at,
  ruleIds: ['a-max'],
  rules: [rule(2)],
  status: 'INVALID',
  target,
  unitRevisions: unitRevisions(at),
};
const unknownAssessment: CurrentConfigurationAssessment = {
  assessedAt: at,
  choiceRevisions: choiceRevisions(2),
  code: 'CURRENT_DEFINITION_UNAVAILABLE',
  definitionId: definitionRef.resourceId,
  definitionRevision: 2,
  effectiveFrom: at,
  ruleIds: [],
  rules: [rule(2)],
  status: 'INDETERMINATE',
  target,
  unitRevisions: unitRevisions(at),
};

const authority: ProductConfigurationReassessmentAuthority = {
  complete: true,
  observedAt: at,
  revisionToken: 'open-selection-revision-1',
  selectionId: 'open-selection-1',
};
const attestedRule = (source: ProductConfigurationDefinitionRevision) => ({
  definitionRevision: source.reference,
  kind: 'MEASURED' as const,
  ownerModuleId: 'commerce.catalog' as const,
  revision: source.reference.revision,
  ruleId: 'measured:length:product:all-packages',
});
const attestation: ProductConfigurationRevisionEquivalenceAttestation = {
  admissibility: {
    completeCurrentRuleBasis: true,
    left: 'ADMISSIBLE',
    leftRuleRevisions: [attestedRule(earlierDefinition)],
    right: 'ADMISSIBLE',
    rightRuleRevisions: [attestedRule(renamedDefinition)],
  },
  attestationId: 'owner-equivalence-1',
  leftSelection: earlierSelection,
  meaning: { choicesAndValues: 'SAME', units: 'SAME' },
  ownerModuleId: 'commerce.catalog',
  rightSelection: renamedSelection,
  source: 'CATALOG_OWNER_EQUIVALENCE_ASSESSMENT',
  status: 'CONFIRMED',
};

const reassess = (
  overrides: Partial<Parameters<typeof reassessProductConfigurationChange>[0]> = {},
): ReturnType<typeof reassessProductConfigurationChange> =>
  reassessProductConfigurationChange({
    authority,
    current: { assessment: renamedAssessment, definition: renamedDefinition, input: currentInput },
    earlier: { assessment: earlierAssessment, definition: earlierDefinition, input: earlierInput },
    selection: earlierSelection,
    ...overrides,
  });

describe('Product Configuration change reassessment (#461)', () => {
  it('invalidates an earlier selection after a material Definition revision change without rewriting it', () => {
    const before = JSON.stringify(earlierSelection);
    const result = reassess({
      current: { assessment: invalidAssessment, definition: successorDefinition, input: currentInput },
    });
    expect(result).toMatchObject({
      code: 'INCOMPATIBLE_COMBINATION',
      currentDefinitionRevision: 2,
      ruleIds: ['a-max'],
      status: 'INVALIDATED',
    });
    expect(result.selection).toEqual(earlierSelection);
    expect(result.selection.definition.revision).toBe(1);
    expect(JSON.stringify(earlierSelection)).toBe(before);
  });

  it('never repairs a newly inadmissible value or substitutes another option', () => {
    const overLengthSelection: ProductConfiguration = {
      ...earlierSelection,
      values: [
        { amount: '110', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
        { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
      ],
    };
    const overLengthInput: CurrentConfigurationAssessmentInput = {
      at,
      target,
      values: [
        { amount: '110', choiceKey: 'length', kind: 'MEASURED_VALUE', unitId: unitRef.resourceId },
        { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
      ],
    };
    const result = reassessProductConfigurationChange({
      authority,
      current: { assessment: invalidAssessment, definition: successorDefinition, input: overLengthInput },
      earlier: { assessment: earlierAssessment, definition: earlierDefinition, input: overLengthInput },
      selection: overLengthSelection,
    });
    expect(result.status).toBe('INVALIDATED');
    expect(result.selection.values).toEqual([
      { amount: '110', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
      { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
    ]);
  });

  it('keeps a display-only rename current through owner-attested equivalence', () => {
    const result = reassess({ attestation });
    expect(result).toMatchObject({
      changeKind: 'DOCUMENTED_EQUIVALENCE',
      currentDefinitionRevision: 2,
      status: 'CURRENT',
    });
    expect(result.selection).toEqual(earlierSelection);
    expect(result.selection.definition.revision).toBe(1);
  });

  it('does not report equivalence for a revision change without the #460 owner attestation', () => {
    expect(reassess().status).toBe('INDETERMINATE');
    const meaningChanged: CurrentConfigurationAssessment = {
      ...renamedAssessment,
      choiceRevisions: renamedAssessment.choiceRevisions.map((choice) =>
        choice.choiceKey === 'mount' ? { ...choice, meaning: 'Different component role' } : choice,
      ),
    };
    expect(
      reassess({
        attestation,
        current: { assessment: meaningChanged, definition: renamedDefinition, input: currentInput },
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('fails closed without complete owner-issued #479 open-selection evidence', () => {
    const missing = reassessProductConfigurationChange({
      current: { assessment: renamedAssessment, definition: renamedDefinition, input: currentInput },
      earlier: { assessment: earlierAssessment, definition: earlierDefinition, input: earlierInput },
      selection: earlierSelection,
    });
    expect(missing).toMatchObject({ reason: expect.stringContaining('#479'), status: 'INDETERMINATE' });
    expect(reassess({ authority: { ...authority, revisionToken: '   ' } }).status).toBe('INDETERMINATE');
    expect(reassess({ authority: { ...authority, selectionId: '' } }).status).toBe('INDETERMINATE');
    expect(reassess({ authority: { ...authority, observedAt: new Date('2020-01-01T00:00:00.000Z') } }).status).toBe(
      'INDETERMINATE',
    );
  });

  it('fails closed when the Current assessment is missing, unknown, or no longer valid', () => {
    expect(reassess({ current: { definition: renamedDefinition, input: currentInput } }).status).toBe('INDETERMINATE');
    expect(
      reassess({
        current: { assessment: unknownAssessment, definition: renamedDefinition, input: currentInput },
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('retains the exact earlier revision when Current is the same revision', () => {
    const sameRevision = reassess({
      current: { assessment: validAssessment(1, at), definition: earlierDefinition, input: currentInput },
    });
    expect(sameRevision).toMatchObject({
      changeKind: 'EXACT_REVISION',
      currentDefinitionRevision: 1,
      status: 'CURRENT',
    });
    expect(sameRevision.selection).toEqual(earlierSelection);
  });

  it('does not accept an earlier assessment that attests a different revision', () => {
    expect(
      reassess({
        attestation,
        earlier: { assessment: renamedAssessment, definition: earlierDefinition, input: earlierInput },
      }).status,
    ).toBe('INDETERMINATE');
  });
});
