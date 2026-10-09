import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
} from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogUnitConversionEvidenceSchema } from '../../shared/domain/catalog-unit-conversion-evidence.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
  ProductConfigurationRevisionEquivalenceAttestation,
} from '../../shared/domain/product-configuration.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import {
  assessProductConfigurationEquivalence,
  productConfigurationRevisionEquivalenceAttestationFor,
} from '../../src/domain/product-configuration-equivalence.ts';
import type {
  CurrentConfigurationAssessment,
  CurrentConfigurationAssessmentInput,
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
const definition = (revision: number): ProductConfigurationDefinitionRevision => ({
  choices: [
    { choiceKey: 'length', kind: 'MEASURED_VALUE', meaning: 'Exact length', required: true, unitRef },
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      meaning: 'Mount',
      options: [{ label: 'A', meaning: 'Part A', optionKey: 'A' }],
      required: true,
    },
  ],
  productRef,
  reference: { resourceRef: definitionRef, revision: Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(revision) },
});
const leftDefinition = definition(1);
const rightDefinition = definition(2);
const selection = (source: ProductConfigurationDefinitionRevision): ProductConfiguration => ({
  definition: source.reference,
  productRef,
  values: [
    { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitRef },
    { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
  ],
  variantRef,
});
const left = selection(leftDefinition);
const right = selection(rightDefinition);
const at = new Date('2026-09-18T12:00:00.000Z');
const input: CurrentConfigurationAssessmentInput = {
  at,
  target: {
    definitionId: definitionRef.resourceId,
    productId: productRef.resourceId,
    variantId: variantRef.resourceId,
  },
  values: [
    { amount: '83', choiceKey: 'length', kind: 'MEASURED_VALUE', unitId: unitRef.resourceId },
    { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' },
  ],
};
const assessment = (revision: number): CurrentConfigurationAssessment => ({
  assessedAt: at,
  choiceRevisions: [
    {
      choiceKey: 'length',
      evidenceRefs: ['definition-evidence'],
      kind: 'MEASURED_VALUE',
      meaning: 'Exact length',
      options: [],
      ownerModuleId: 'commerce.catalog',
      required: true,
      revision,
      unitId: unitRef.resourceId,
      unitRevision: 1,
    },
    {
      choiceKey: 'mount',
      evidenceRefs: ['definition-evidence'],
      kind: 'SINGLE_CHOICE',
      meaning: 'Mount',
      options: [{ meaning: 'Part A', optionKey: 'A' }],
      ownerModuleId: 'commerce.catalog',
      required: true,
      revision,
    },
  ],
  definitionId: definitionRef.resourceId,
  definitionRevision: revision,
  rules: [
    {
      definitionRevision: revision,
      evidenceRefs: ['owner-evidence'],
      kind: 'MEASURED',
      ownerModuleId: 'commerce.catalog',
      revision,
      ruleId: 'measured:length:product:all-packages',
    },
  ],
  status: 'VALID',
  target: input.target,
  unitRevisions: [
    {
      dimension: 'length',
      effectiveFrom: at,
      evidenceRefs: ['unit-evidence'],
      lifecycleState: 'ACTIVE',
      meaning: 'Centimetre',
      ref: unitRef,
      revision: 1,
    },
  ],
});
const rule = (source: ProductConfigurationDefinitionRevision) => ({
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
    leftRuleRevisions: [rule(leftDefinition)],
    right: 'ADMISSIBLE',
    rightRuleRevisions: [rule(rightDefinition)],
  },
  attestationId: 'owner-assessment',
  leftSelection: left,
  meaning: { choicesAndValues: 'SAME', units: 'SAME' },
  ownerModuleId: 'commerce.catalog',
  rightSelection: right,
  source: 'CATALOG_OWNER_EQUIVALENCE_ASSESSMENT',
  status: 'CONFIRMED',
};

const compare = (
  rightInput: CurrentConfigurationAssessmentInput = input,
  rightAssessment: CurrentConfigurationAssessment | undefined = assessment(2),
  proof: ProductConfigurationRevisionEquivalenceAttestation | undefined = attestation,
) =>
  assessProductConfigurationEquivalence(
    left,
    leftDefinition,
    input,
    assessment(1),
    right,
    rightDefinition,
    rightInput,
    rightAssessment,
    proof,
  );

describe('owner-private Product Configuration equivalence gate', () => {
  it('issues owner equivalence only from exact matching Current assessments', () => {
    const issued = productConfigurationRevisionEquivalenceAttestationFor({
      attestationId: 'catalog-equivalence-1',
      left: { assessment: assessment(1), definition: leftDefinition, input, selection: left },
      right: { assessment: assessment(2), definition: rightDefinition, input, selection: right },
    });
    expect(issued).toMatchObject({
      attestationId: 'catalog-equivalence-1',
      ownerModuleId: 'commerce.catalog',
      source: 'CATALOG_OWNER_EQUIVALENCE_ASSESSMENT',
      status: 'CONFIRMED',
    });
    expect(compare(input, assessment(2), issued)).toMatchObject({ same: true, status: 'VALID' });

    const changedMeaning = assessment(2).choiceRevisions.map((choice) =>
      choice.choiceKey === 'mount' ? { ...choice, meaning: 'Different component role' } : choice,
    );
    expect(
      productConfigurationRevisionEquivalenceAttestationFor({
        attestationId: 'catalog-equivalence-2',
        left: { assessment: assessment(1), definition: leftDefinition, input, selection: left },
        right: {
          assessment: { ...assessment(2), choiceRevisions: changedMeaning },
          definition: rightDefinition,
          input,
          selection: right,
        },
      }),
    ).toBeUndefined();
    expect(
      productConfigurationRevisionEquivalenceAttestationFor({
        attestationId: '   ',
        left: { assessment: assessment(1), definition: leftDefinition, input, selection: left },
        right: { assessment: assessment(2), definition: rightDefinition, input, selection: right },
      }),
    ).toBeUndefined();
    expect(
      productConfigurationRevisionEquivalenceAttestationFor({
        attestationId: 'catalog-equivalence-foreign-rule',
        left: { assessment: assessment(1), definition: leftDefinition, input, selection: left },
        right: {
          assessment: {
            ...assessment(2),
            rules: assessment(2).rules.map((item) => ({ ...item, ownerModuleId: 'commerce.sales' })),
          },
          definition: rightDefinition,
          input,
          selection: right,
        },
      }),
    ).toBeUndefined();
  });

  it('requires exact owner assessments and matching rule bases', () => {
    const missingProof = new Map<string, ProductConfigurationRevisionEquivalenceAttestation>().get('missing');
    const missingAssessment = new Map<string, CurrentConfigurationAssessment>().get('missing');
    expect(compare()).toMatchObject({ same: true, status: 'VALID' });
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        assessment(1),
        right,
        rightDefinition,
        input,
        missingAssessment,
        attestation,
      ).status,
    ).toBe('INDETERMINATE');
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        assessment(1),
        right,
        rightDefinition,
        input,
        assessment(2),
        missingProof,
      ).status,
    ).toBe('INDETERMINATE');
    expect(compare(input, { ...assessment(2), rules: [] }).status).toBe('INDETERMINATE');
    expect(
      compare(input, {
        ...assessment(2),
        rules: [{ evidenceRefs: ['owner-evidence'], revision: 2, ruleId: 'other-rule' }],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('does not reuse a valid assessment for a different value or target', () => {
    expect(
      compare({
        ...input,
        values: [{ amount: '84', choiceKey: 'length', kind: 'MEASURED_VALUE', unitId: unitRef.resourceId }],
      }).status,
    ).toBe('INDETERMINATE');
    expect(compare({ ...input, target: { ...input.target, variantId: 'other' } }).status).toBe('INDETERMINATE');
    expect(compare({ ...input, values: [...input.values, input.values[0]] }).status).toBe('INDETERMINATE');
  });

  it('does not infer unchanged meaning from equal keys, values, or display labels', () => {
    const current = assessment(2);
    const changedChoice = current.choiceRevisions.map((choice) =>
      choice.choiceKey === 'mount' ? { ...choice, meaning: 'Different component role' } : choice,
    );
    expect(compare(input, { ...current, choiceRevisions: changedChoice }).status).toBe('INDETERMINATE');
    const changedOption = current.choiceRevisions.map((choice) =>
      choice.choiceKey === 'mount' ? { ...choice, options: [{ meaning: 'Different Part A', optionKey: 'A' }] } : choice,
    );
    expect(compare(input, { ...current, choiceRevisions: changedOption }).status).toBe('INDETERMINATE');
  });

  it('requires the exact Unit revision and sourced rule kind', () => {
    const current = assessment(2);
    expect(
      compare(input, { ...current, unitRevisions: current.unitRevisions.map((unit) => ({ ...unit, revision: 2 })) })
        .status,
    ).toBe('INDETERMINATE');
    expect(
      compare(input, {
        ...current,
        choiceRevisions: current.choiceRevisions.map((choice) =>
          choice.choiceKey === 'length' ? { ...choice, unitRevision: 2 } : choice,
        ),
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      compare(input, { ...current, rules: current.rules.map((item) => ({ ...item, evidenceRefs: [] })) }).status,
    ).toBe('INDETERMINATE');
    const wrongKind: ProductConfigurationRevisionEquivalenceAttestation = {
      ...attestation,
      admissibility: {
        ...attestation.admissibility,
        rightRuleRevisions: attestation.admissibility.rightRuleRevisions.map((item) => ({ ...item, kind: 'CHOICE' })),
      },
    };
    expect(compare(input, current, wrongKind).status).toBe('INDETERMINATE');
  });

  it('requires owner-qualified rule source and an exact assessed Definition revision', () => {
    const current = assessment(2);
    expect(
      compare(input, { ...current, rules: current.rules.map((item) => ({ ...item, ownerModuleId: 'commerce.sales' })) })
        .status,
    ).toBe('INDETERMINATE');
    expect(
      compare(input, { ...current, rules: current.rules.map((item) => ({ ...item, definitionRevision: 99 })) }).status,
    ).toBe('INDETERMINATE');
    expect(
      compare(input, {
        ...current,
        rules: [{ evidenceRefs: ['owner-evidence'], revision: 2, ruleId: 'measured:length:product:all-packages' }],
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('accepts a proven compatibility rule and rejects a foreign or unsupported source', () => {
    const compatibilityRuleId = 'compatibility:mount-a-length-limit';
    const assessedCompatibility = (definitionRevision: number) => ({
      definitionRevision,
      evidenceRefs: ['compatibility-evidence'],
      kind: 'COMPATIBILITY' as const,
      ownerModuleId: 'commerce.catalog',
      revision: definitionRevision,
      ruleId: compatibilityRuleId,
    });
    const attestedCompatibility = (source: ProductConfigurationDefinitionRevision) => ({
      definitionRevision: source.reference,
      kind: 'COMPATIBILITY' as const,
      ownerModuleId: 'commerce.catalog' as const,
      revision: source.reference.revision,
      ruleId: compatibilityRuleId,
    });
    const leftWithRule: CurrentConfigurationAssessment = {
      ...assessment(1),
      rules: [...assessment(1).rules, assessedCompatibility(1)],
    };
    const rightWithRule: CurrentConfigurationAssessment = {
      ...assessment(2),
      rules: [...assessment(2).rules, assessedCompatibility(2)],
    };
    const proof: ProductConfigurationRevisionEquivalenceAttestation = {
      ...attestation,
      admissibility: {
        ...attestation.admissibility,
        leftRuleRevisions: [...attestation.admissibility.leftRuleRevisions, attestedCompatibility(leftDefinition)],
        rightRuleRevisions: [...attestation.admissibility.rightRuleRevisions, attestedCompatibility(rightDefinition)],
      },
    };
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        leftWithRule,
        right,
        rightDefinition,
        input,
        rightWithRule,
        proof,
      ),
    ).toMatchObject({ same: true, status: 'VALID' });
    const foreignRule: CurrentConfigurationAssessment = {
      ...rightWithRule,
      rules: rightWithRule.rules.map((item) =>
        item.ruleId === compatibilityRuleId ? { ...item, ownerModuleId: 'commerce.sales' } : item,
      ),
    };
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        leftWithRule,
        right,
        rightDefinition,
        input,
        foreignRule,
        proof,
      ).status,
    ).toBe('INDETERMINATE');
    const unsupportedKind: CurrentConfigurationAssessment = {
      ...rightWithRule,
      rules: rightWithRule.rules.map((item) =>
        item.ruleId === compatibilityRuleId ? { ...item, kind: 'CHOICE' as const } : item,
      ),
    };
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        leftWithRule,
        right,
        rightDefinition,
        input,
        unsupportedKind,
        proof,
      ).status,
    ).toBe('INDETERMINATE');
  });

  it('rejects blank or whitespace-only choice and Unit evidence refs', () => {
    const current = assessment(2);
    expect(
      compare(input, {
        ...current,
        choiceRevisions: current.choiceRevisions.map((choice) =>
          choice.choiceKey === 'mount' ? { ...choice, evidenceRefs: ['   '] } : choice,
        ),
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      compare(input, {
        ...current,
        unitRevisions: current.unitRevisions.map((unit) => ({ ...unit, evidenceRefs: ['  '] })),
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('does not treat 83 cm and 830 mm as equal without a lossless conversion proof', () => {
    const millimetre = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666');
    const changedDefinition: ProductConfigurationDefinitionRevision = {
      ...rightDefinition,
      choices: rightDefinition.choices.map((choice) =>
        choice.kind === 'MEASURED_VALUE' ? { ...choice, unitRef: millimetre } : choice,
      ),
    };
    const changedSelection: ProductConfiguration = {
      ...right,
      values: right.values.map((value) =>
        value.kind === 'MEASURED_VALUE' ? { ...value, amount: '830', unitRef: millimetre } : value,
      ),
    };
    const changedInput: CurrentConfigurationAssessmentInput = {
      ...input,
      values: input.values.map((value) =>
        value.kind === 'MEASURED_VALUE' ? { ...value, amount: '830', unitId: millimetre.resourceId } : value,
      ),
    };
    const current = assessment(2);
    const changedAssessment: CurrentConfigurationAssessment = {
      ...current,
      choiceRevisions: current.choiceRevisions.map((choice) =>
        choice.choiceKey === 'length' ? { ...choice, unitId: millimetre.resourceId } : choice,
      ),
      unitRevisions: current.unitRevisions.map((unit) => ({ ...unit, meaning: 'Millimetre', ref: millimetre })),
    };
    const claimedProof: ProductConfigurationRevisionEquivalenceAttestation = {
      ...attestation,
      rightSelection: changedSelection,
    };
    expect(
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        assessment(1),
        changedSelection,
        changedDefinition,
        changedInput,
        changedAssessment,
        claimedProof,
      ),
    ).toMatchObject({
      reason: 'Different Unit identities require an owner-qualified proof of lossless conversion',
      status: 'INDETERMINATE',
    });
  });

  it('accepts an exactly proven conversion and rejects unproven or foreign-unit evidence', () => {
    const millimetre = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666');
    const changedDefinition: ProductConfigurationDefinitionRevision = {
      ...rightDefinition,
      choices: rightDefinition.choices.map((choice) =>
        choice.kind === 'MEASURED_VALUE' ? { ...choice, unitRef: millimetre } : choice,
      ),
    };
    const changedSelection: ProductConfiguration = {
      ...right,
      values: right.values.map((value) =>
        value.kind === 'MEASURED_VALUE' ? { ...value, amount: '830', unitRef: millimetre } : value,
      ),
    };
    const changedInput: CurrentConfigurationAssessmentInput = {
      ...input,
      values: input.values.map((value) =>
        value.kind === 'MEASURED_VALUE' ? { ...value, amount: '830', unitId: millimetre.resourceId } : value,
      ),
    };
    const current = assessment(2);
    const changedAssessment: CurrentConfigurationAssessment = {
      ...current,
      choiceRevisions: current.choiceRevisions.map((choice) =>
        choice.choiceKey === 'length' ? { ...choice, unitId: millimetre.resourceId } : choice,
      ),
      unitRevisions: current.unitRevisions.map((unit) => ({ ...unit, meaning: 'Millimetre', ref: millimetre })),
    };
    const claimedProof: ProductConfigurationRevisionEquivalenceAttestation = {
      ...attestation,
      rightSelection: changedSelection,
    };
    const conversion = (numerator: string, denominator: string, toRevision = 1) =>
      Schema.decodeUnknownSync(CatalogUnitConversionEvidenceSchema)({
        denominator,
        evidenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        from: { resourceRef: unitRef, revision: 1 },
        numerator,
        observedAt: '2026-09-18T12:00:00.000Z',
        ownerModuleId: 'commerce.catalog',
        source: 'CATALOG_OWNER_CURRENT_READ',
        to: { resourceRef: millimetre, revision: toRevision },
      });
    const compareConverted = (proofs: readonly ReturnType<typeof conversion>[]) =>
      assessProductConfigurationEquivalence(
        left,
        leftDefinition,
        input,
        assessment(1),
        changedSelection,
        changedDefinition,
        changedInput,
        changedAssessment,
        claimedProof,
        proofs,
      );
    expect(compareConverted([conversion('10', '1')])).toMatchObject({ same: true, status: 'VALID' });
    expect(compareConverted([conversion('1', '1')])).toMatchObject({ status: 'INDETERMINATE' });
    expect(compareConverted([conversion('10', '1', 2)])).toMatchObject({ status: 'INDETERMINATE' });
    expect(compareConverted([])).toMatchObject({ status: 'INDETERMINATE' });
    const foreignEndpoint = Schema.decodeUnknownSync(CatalogUnitConversionEvidenceSchema)({
      denominator: '1',
      evidenceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      from: { resourceRef: ref('commerce.catalog.unit', '77777777-7777-4777-8777-777777777777'), revision: 1 },
      numerator: '10',
      observedAt: '2026-09-18T12:00:00.000Z',
      ownerModuleId: 'commerce.catalog',
      source: 'CATALOG_OWNER_CURRENT_READ',
      to: { resourceRef: millimetre, revision: 1 },
    });
    expect(compareConverted([foreignEndpoint])).toMatchObject({ status: 'INDETERMINATE' });
  });
});
