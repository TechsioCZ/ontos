import { Schema } from 'effect';

import { catalogUnitConversionProves } from '../../shared/domain/catalog-unit-conversion-evidence.ts';
import type {
  CatalogUnitConversionEvidence,
  CatalogUnitRevisionReference,
} from '../../shared/domain/catalog-unit-conversion-evidence.ts';
import { sameProductConfigurationSelectionAcrossRevisions } from '../../shared/domain/product-configuration.ts';
import type {
  ConfigurationRuleRevisionEvidence,
  ConfigurationInspection,
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
  ProductConfigurationRevisionEquivalenceAttestation,
} from '../../shared/domain/product-configuration.ts';
import type {
  CurrentConfigurationAssessment,
  CurrentConfigurationAssessmentInput,
} from '../persistence/product-configuration-current-evaluator.ts';

const assessmentMatchesSelection = (
  assessment: CurrentConfigurationAssessment,
  input: CurrentConfigurationAssessmentInput,
  selection: ProductConfiguration,
): boolean => {
  if (
    assessment.definitionId !== selection.definition.resourceRef.resourceId ||
    assessment.definitionRevision !== selection.definition.revision ||
    assessment.target.definitionId !== assessment.definitionId ||
    assessment.target.productId !== selection.productRef.resourceId ||
    assessment.target.variantId !== selection.variantRef.resourceId ||
    assessment.target.packageDefinitionId !== selection.packageOptionRef?.resourceId ||
    assessment.target.packageDefinitionId !== input.target.packageDefinitionId ||
    assessment.assessedAt.getTime() !== input.at.getTime() ||
    input.target.definitionId !== assessment.target.definitionId ||
    input.target.productId !== assessment.target.productId ||
    input.target.variantId !== assessment.target.variantId ||
    input.values.length !== selection.values.length
  ) {
    return false;
  }
  const assessed = new Map(input.values.map((value) => [value.choiceKey, value]));
  if (assessed.size !== input.values.length) {
    return false;
  }
  return selection.values.every((value) => {
    const other = assessed.get(value.choiceKey);
    return (
      other !== undefined &&
      value.kind === other.kind &&
      (value.kind === 'SINGLE_CHOICE' && other.kind === 'SINGLE_CHOICE'
        ? value.optionKey === other.optionKey
        : value.kind === 'MEASURED_VALUE' &&
          other.kind === 'MEASURED_VALUE' &&
          value.amount === other.amount &&
          value.unitRef.resourceId === other.unitId)
    );
  });
};

const catalogOwner = 'commerce.catalog';
const catalogUnitType = 'commerce.catalog.unit';

/** Whether Unit identity must match exactly or only be owner-qualified (conversion proven separately). */
const UnitPolicySchema = Schema.Literals(['EXACT', 'OWNER_QUALIFIED']);
type UnitPolicy = typeof UnitPolicySchema.Type;

const sameRuleBasis = (
  attested: ProductConfigurationRevisionEquivalenceAttestation['admissibility']['leftRuleRevisions'],
  assessment: CurrentConfigurationAssessment,
): boolean => {
  const attestedIds = new Set(attested.map((rule) => rule.ruleId));
  const assessedIds = new Set(assessment.rules.map((rule) => rule.ruleId));
  return (
    attested.length === assessment.rules.length &&
    attestedIds.size === attested.length &&
    assessedIds.size === assessment.rules.length &&
    assessment.definitionRevision !== undefined &&
    attested.every(
      (rule) =>
        rule.ownerModuleId === catalogOwner &&
        rule.definitionRevision.resourceRef.moduleId === catalogOwner &&
        rule.definitionRevision.resourceRef.resourceId === assessment.definitionId &&
        rule.definitionRevision.revision === assessment.definitionRevision &&
        assessment.rules.some(
          (assessed) =>
            assessed.ruleId === rule.ruleId &&
            assessed.revision === rule.revision &&
            assessed.kind === rule.kind &&
            assessed.ownerModuleId === catalogOwner &&
            assessed.definitionRevision === assessment.definitionRevision &&
            assessed.evidenceRefs.length > 0 &&
            assessed.evidenceRefs.every((ref) => ref.trim().length > 0),
        ),
    )
  );
};

type RecordedChoice = CurrentConfigurationAssessment['choiceRevisions'][number];
type DefinedChoice = ProductConfigurationDefinitionRevision['choices'][number];

const definedChoiceMatches = (
  choice: RecordedChoice,
  other: RecordedChoice,
  definedLeft: DefinedChoice,
  definedRight: DefinedChoice,
): boolean =>
  definedLeft.kind === choice.kind &&
  definedRight.kind === other.kind &&
  definedLeft.meaning === choice.meaning &&
  definedRight.meaning === other.meaning &&
  definedLeft.required === choice.required &&
  definedRight.required === other.required;

const sameChoiceEvidence = (
  choice: RecordedChoice,
  other: RecordedChoice,
  leftRevision: number | undefined,
  rightRevision: number | undefined,
): boolean =>
  choice.ownerModuleId === catalogOwner &&
  other.ownerModuleId === catalogOwner &&
  choice.revision === leftRevision &&
  other.revision === rightRevision &&
  choice.evidenceRefs.length > 0 &&
  other.evidenceRefs.length > 0 &&
  choice.evidenceRefs.every((ref) => ref.trim().length > 0) &&
  other.evidenceRefs.every((ref) => ref.trim().length > 0);

const sameRecordedChoiceFacts = (choice: RecordedChoice, other: RecordedChoice, unitPolicy: UnitPolicy): boolean =>
  choice.kind === other.kind &&
  choice.meaning === other.meaning &&
  choice.required === other.required &&
  choice.options.length === other.options.length &&
  (unitPolicy === 'EXACT' ? choice.unitId === other.unitId && choice.unitRevision === other.unitRevision : true);

const measuredUnitIdentityMatches = (
  choice: RecordedChoice,
  other: RecordedChoice,
  definedLeft: DefinedChoice,
  definedRight: DefinedChoice,
): boolean => {
  if (definedLeft.kind !== 'MEASURED_VALUE' || definedRight.kind !== 'MEASURED_VALUE') {
    return true;
  }
  return definedLeft.unitRef.resourceId === choice.unitId && definedRight.unitRef.resourceId === other.unitId;
};

const sameChoiceOptionMeanings = (choice: RecordedChoice, other: RecordedChoice): boolean => {
  const options = new Map(other.options.map((option) => [option.optionKey, option.meaning]));
  return (
    options.size === other.options.length &&
    choice.options.every((option) => options.get(option.optionKey) === option.meaning)
  );
};

const sameChoiceMeaning = (
  choice: RecordedChoice,
  other: RecordedChoice | undefined,
  definedLeft: DefinedChoice | undefined,
  definedRight: DefinedChoice | undefined,
  leftRevision: number | undefined,
  rightRevision: number | undefined,
  unitPolicy: UnitPolicy,
): boolean => {
  if (other === undefined || definedLeft === undefined || definedRight === undefined) {
    return false;
  }
  return (
    definedChoiceMatches(choice, other, definedLeft, definedRight) &&
    sameChoiceEvidence(choice, other, leftRevision, rightRevision) &&
    sameRecordedChoiceFacts(choice, other, unitPolicy) &&
    measuredUnitIdentityMatches(choice, other, definedLeft, definedRight) &&
    sameChoiceOptionMeanings(choice, other)
  );
};

const sameExactUnit = (
  unitId: string,
  left: CurrentConfigurationAssessment,
  right: CurrentConfigurationAssessment,
): boolean => {
  const leftUnits = left.unitRevisions.filter((unit) => unit.ref.resourceId === unitId);
  const rightUnits = right.unitRevisions.filter((unit) => unit.ref.resourceId === unitId);
  const [leftUnit] = leftUnits;
  const [rightUnit] = rightUnits;
  return (
    leftUnits.length === 1 &&
    rightUnits.length === 1 &&
    leftUnit !== undefined &&
    rightUnit !== undefined &&
    leftUnit.ref.moduleId === catalogOwner &&
    rightUnit.ref.moduleId === catalogOwner &&
    leftUnit.ref.resourceType === catalogUnitType &&
    rightUnit.ref.resourceType === catalogUnitType &&
    leftUnit.ref.tenantId === rightUnit.ref.tenantId &&
    leftUnit.revision === rightUnit.revision &&
    leftUnit.meaning === rightUnit.meaning &&
    leftUnit.dimension === rightUnit.dimension &&
    leftUnit.evidenceRefs.length > 0 &&
    leftUnit.evidenceRefs.every((ref) => ref.trim().length > 0) &&
    rightUnit.evidenceRefs.length > 0 &&
    rightUnit.evidenceRefs.every((ref) => ref.trim().length > 0)
  );
};

const ownerQualifiedUnit = (unitId: string, assessment: CurrentConfigurationAssessment): boolean => {
  const units = assessment.unitRevisions.filter((unit) => unit.ref.resourceId === unitId);
  const [unit] = units;
  return (
    units.length === 1 &&
    unit !== undefined &&
    unit.ref.moduleId === catalogOwner &&
    unit.ref.resourceType === catalogUnitType &&
    unit.evidenceRefs.length > 0 &&
    unit.evidenceRefs.every((ref) => ref.trim().length > 0)
  );
};

const ownerQualifiedMeasuredUnits = (
  leftSelection: ProductConfiguration,
  rightSelection: ProductConfiguration,
  left: CurrentConfigurationAssessment,
  right: CurrentConfigurationAssessment,
): boolean => {
  const rightValues = new Map(rightSelection.values.map((value) => [value.choiceKey, value]));
  return leftSelection.values.every((value) => {
    if (value.kind !== 'MEASURED_VALUE') {
      return true;
    }
    const other = rightValues.get(value.choiceKey);
    return (
      other?.kind === 'MEASURED_VALUE' &&
      ownerQualifiedUnit(value.unitRef.resourceId, left) &&
      ownerQualifiedUnit(other.unitRef.resourceId, right)
    );
  });
};

const sameRecordedMeaning = (
  left: CurrentConfigurationAssessment,
  right: CurrentConfigurationAssessment,
  leftDefinition: ProductConfigurationDefinitionRevision,
  rightDefinition: ProductConfigurationDefinitionRevision,
  leftSelection: ProductConfiguration,
  rightSelection: ProductConfiguration,
  unitPolicy: UnitPolicy = 'EXACT',
): boolean => {
  if (
    left.choiceRevisions.length !== right.choiceRevisions.length ||
    left.choiceRevisions.length !== leftDefinition.choices.length ||
    right.choiceRevisions.length !== rightDefinition.choices.length
  ) {
    return false;
  }
  const rightChoices = new Map(right.choiceRevisions.map((choice) => [choice.choiceKey, choice]));
  if (rightChoices.size !== right.choiceRevisions.length) {
    return false;
  }
  const choicesMatch = left.choiceRevisions.every((choice) =>
    sameChoiceMeaning(
      choice,
      rightChoices.get(choice.choiceKey),
      leftDefinition.choices.find((item) => item.choiceKey === choice.choiceKey),
      rightDefinition.choices.find((item) => item.choiceKey === choice.choiceKey),
      left.definitionRevision,
      right.definitionRevision,
      unitPolicy,
    ),
  );
  if (!choicesMatch) {
    return false;
  }
  const measuredUnits: string[] = [];
  for (const value of leftSelection.values) {
    if (value.kind === 'MEASURED_VALUE') {
      measuredUnits.push(value.unitRef.resourceId);
    }
  }
  if (measuredUnits.length !== rightSelection.values.filter((value) => value.kind === 'MEASURED_VALUE').length) {
    return false;
  }
  return unitPolicy === 'EXACT'
    ? measuredUnits.every((unitId) => sameExactUnit(unitId, left, right))
    : ownerQualifiedMeasuredUnits(leftSelection, rightSelection, left, right);
};

/**
 * Rule 4 permits a documented lossless conversion to unify different Unit identities. This private
 * gate cannot supply that proof itself; the owner-qualified `CatalogUnitConversionEvidence` path
 * owned with Catalog Selection (#479) carries the exact ratio. Without matching evidence the
 * divergence stays INDETERMINATE rather than guessing a factor from caller data.
 */
const measuredUnitsDiffer = (left: ProductConfiguration, right: ProductConfiguration): boolean => {
  const rightValues = new Map(right.values.map((value) => [value.choiceKey, value]));
  return left.values.some((value) => {
    const other = rightValues.get(value.choiceKey);
    return (
      value.kind === 'MEASURED_VALUE' &&
      other?.kind === 'MEASURED_VALUE' &&
      value.unitRef.resourceId !== other.unitRef.resourceId
    );
  });
};

const unitRevisionReference = (
  assessment: CurrentConfigurationAssessment,
  unitId: string,
): CatalogUnitRevisionReference | undefined => {
  const units = assessment.unitRevisions.filter((unit) => unit.ref.resourceId === unitId);
  const [unit] = units;
  return units.length === 1 && unit !== undefined && ownerQualifiedUnit(unitId, assessment)
    ? { resourceRef: unit.ref, revision: unit.revision }
    : undefined;
};

const losslessUnitConversionProven = (
  leftSelection: ProductConfiguration,
  left: CurrentConfigurationAssessment,
  rightSelection: ProductConfiguration,
  right: CurrentConfigurationAssessment,
  evidence: readonly CatalogUnitConversionEvidence[],
): boolean => {
  const rightValues = new Map(rightSelection.values.map((value) => [value.choiceKey, value]));
  return leftSelection.values.every((value) => {
    if (value.kind !== 'MEASURED_VALUE') {
      return true;
    }
    const other = rightValues.get(value.choiceKey);
    if (other?.kind !== 'MEASURED_VALUE') {
      return false;
    }
    if (value.unitRef.resourceId === other.unitRef.resourceId) {
      return true;
    }
    const from = unitRevisionReference(left, value.unitRef.resourceId);
    const to = unitRevisionReference(right, other.unitRef.resourceId);
    return (
      from !== undefined &&
      to !== undefined &&
      evidence.some((conversion) => catalogUnitConversionProves(conversion, from, to, value.amount, other.amount))
    );
  });
};

/**
 * Owner-private consumption gate. The attestation must come from a trusted Catalog
 * reader; this function cannot authenticate or issue one from caller-supplied data.
 */
const equivalenceProofMatchesRules = (
  attestation: ProductConfigurationRevisionEquivalenceAttestation | undefined,
  left: CurrentConfigurationAssessment,
  right: CurrentConfigurationAssessment,
): boolean =>
  attestation === undefined ||
  (sameRuleBasis(attestation.admissibility.leftRuleRevisions, left) &&
    sameRuleBasis(attestation.admissibility.rightRuleRevisions, right));

const convertedMeaningProven = (
  left: ProductConfiguration,
  leftDefinition: ProductConfigurationDefinitionRevision,
  leftAssessment: CurrentConfigurationAssessment,
  right: ProductConfiguration,
  rightDefinition: ProductConfigurationDefinitionRevision,
  rightAssessment: CurrentConfigurationAssessment,
  unitConversionEvidence: readonly CatalogUnitConversionEvidence[],
): boolean =>
  measuredUnitsDiffer(left, right) &&
  sameRecordedMeaning(
    leftAssessment,
    rightAssessment,
    leftDefinition,
    rightDefinition,
    left,
    right,
    'OWNER_QUALIFIED',
  ) &&
  losslessUnitConversionProven(left, leftAssessment, right, rightAssessment, unitConversionEvidence);

export const assessProductConfigurationEquivalence = (
  left: ProductConfiguration,
  leftDefinition: ProductConfigurationDefinitionRevision | undefined,
  leftInput: CurrentConfigurationAssessmentInput,
  leftAssessment: CurrentConfigurationAssessment | undefined,
  right: ProductConfiguration,
  rightDefinition: ProductConfigurationDefinitionRevision | undefined,
  rightInput: CurrentConfigurationAssessmentInput,
  rightAssessment: CurrentConfigurationAssessment | undefined,
  attestation: ProductConfigurationRevisionEquivalenceAttestation | undefined,
  unitConversionEvidence: readonly CatalogUnitConversionEvidence[] = [],
): ConfigurationInspection & { readonly same?: boolean } => {
  const structural = sameProductConfigurationSelectionAcrossRevisions(
    left,
    leftDefinition,
    right,
    rightDefinition,
    attestation,
  );
  if (structural.status !== 'VALID' || structural.same !== true) {
    return structural;
  }
  if (
    leftAssessment?.status !== 'VALID' ||
    rightAssessment?.status !== 'VALID' ||
    !assessmentMatchesSelection(leftAssessment, leftInput, left) ||
    !assessmentMatchesSelection(rightAssessment, rightInput, right)
  ) {
    return { reason: 'Exact owner admissibility assessments are unavailable', status: 'INDETERMINATE' };
  }
  if (!equivalenceProofMatchesRules(attestation, leftAssessment, rightAssessment)) {
    return { reason: 'Owner equivalence proof does not match assessed rule bases', status: 'INDETERMINATE' };
  }
  if (leftDefinition === undefined || rightDefinition === undefined) {
    return { reason: 'Exact Definition revisions are unavailable', status: 'INDETERMINATE' };
  }
  const exactMeaning = sameRecordedMeaning(
    leftAssessment,
    rightAssessment,
    leftDefinition,
    rightDefinition,
    left,
    right,
  );
  const convertedMeaning =
    !exactMeaning &&
    convertedMeaningProven(
      left,
      leftDefinition,
      leftAssessment,
      right,
      rightDefinition,
      rightAssessment,
      unitConversionEvidence,
    );
  if (!exactMeaning && !convertedMeaning) {
    return {
      reason: measuredUnitsDiffer(left, right)
        ? 'Different Unit identities require an owner-qualified proof of lossless conversion'
        : 'Exact Catalog choice, option, or Unit meaning proof is unavailable',
      status: 'INDETERMINATE',
    };
  }
  return structural;
};

interface ProductConfigurationEquivalenceAttestationSide {
  readonly assessment?: CurrentConfigurationAssessment;
  readonly definition?: ProductConfigurationDefinitionRevision;
  readonly input: CurrentConfigurationAssessmentInput;
  readonly selection: ProductConfiguration;
}

export interface ProductConfigurationEquivalenceAttestationInput {
  readonly attestationId: string;
  readonly left: ProductConfigurationEquivalenceAttestationSide;
  readonly right: ProductConfigurationEquivalenceAttestationSide;
  readonly unitConversionEvidence?: readonly CatalogUnitConversionEvidence[];
}

const attestedRuleRevisions = (
  side: ProductConfigurationEquivalenceAttestationSide,
): readonly ConfigurationRuleRevisionEvidence[] | undefined => {
  const { assessment, definition } = side;
  if (
    assessment?.status !== 'VALID' ||
    definition === undefined ||
    assessment.definitionId !== definition.reference.resourceRef.resourceId ||
    assessment.definitionRevision !== definition.reference.revision
  ) {
    return undefined;
  }
  const revisions: ConfigurationRuleRevisionEvidence[] = [];
  const ruleIds = new Set<string>();
  for (const rule of assessment.rules) {
    if (
      rule.ownerModuleId !== catalogOwner ||
      rule.definitionRevision !== assessment.definitionRevision ||
      rule.kind === undefined ||
      !Number.isSafeInteger(rule.revision) ||
      rule.revision < 1 ||
      rule.ruleId.trim().length === 0 ||
      rule.ruleId !== rule.ruleId.trim() ||
      ruleIds.has(rule.ruleId) ||
      rule.evidenceRefs.length === 0 ||
      rule.evidenceRefs.some((reference) => reference.trim().length === 0)
    ) {
      return undefined;
    }
    ruleIds.add(rule.ruleId);
    revisions.push({
      definitionRevision: definition.reference,
      kind: rule.kind,
      ownerModuleId: catalogOwner,
      revision: rule.revision,
      ruleId: rule.ruleId,
    });
  }
  return revisions;
};

/**
 * Mint #460 evidence only from the two exact Catalog-owner Current assessments. The caller chooses
 * an identity for this assessment, but cannot assert its result: this issuer derives the complete
 * rule bases and returns no attestation unless the existing equivalence gate proves the claim.
 */
export const productConfigurationRevisionEquivalenceAttestationFor = (
  input: ProductConfigurationEquivalenceAttestationInput,
): ProductConfigurationRevisionEquivalenceAttestation | undefined => {
  if (input.attestationId.trim().length === 0 || input.attestationId !== input.attestationId.trim()) {
    return undefined;
  }
  const leftRuleRevisions = attestedRuleRevisions(input.left);
  const rightRuleRevisions = attestedRuleRevisions(input.right);
  if (leftRuleRevisions === undefined || rightRuleRevisions === undefined) {
    return undefined;
  }
  const attestation: ProductConfigurationRevisionEquivalenceAttestation = {
    admissibility: {
      completeCurrentRuleBasis: true,
      left: 'ADMISSIBLE',
      leftRuleRevisions,
      right: 'ADMISSIBLE',
      rightRuleRevisions,
    },
    attestationId: input.attestationId,
    leftSelection: structuredClone(input.left.selection),
    meaning: { choicesAndValues: 'SAME', units: 'SAME' },
    ownerModuleId: catalogOwner,
    rightSelection: structuredClone(input.right.selection),
    source: 'CATALOG_OWNER_EQUIVALENCE_ASSESSMENT',
    status: 'CONFIRMED',
  };
  const proof = assessProductConfigurationEquivalence(
    input.left.selection,
    input.left.definition,
    input.left.input,
    input.left.assessment,
    input.right.selection,
    input.right.definition,
    input.right.input,
    input.right.assessment,
    attestation,
    input.unitConversionEvidence ?? [],
  );
  return proof.status === 'VALID' && proof.same === true ? attestation : undefined;
};
