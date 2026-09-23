import type { CatalogResourceRef, CatalogRevisionInstant } from './catalog-revision-reference.ts';
import { sameCatalogRevisionReference } from './catalog-revision-reference.ts';
import type { CatalogSelectionRevision } from './catalog-selection-evidence.ts';
import { evaluateCompatibilityRules, evaluateMeasuredConstraint } from './configuration-constraints.ts';
import type {
  CompatibilityRule,
  ConfigurationUnitConversion,
  ConfigurationValue,
  MeasuredConstraint,
} from './configuration-constraints.ts';
import {
  inspectConfigurationDefinition,
  inspectProductConfigurationCurrentActivation,
} from './product-configuration.ts';
import type {
  ConfigurationRuleRevisionEvidence,
  ConfigurationMeasuredValue,
  ConfigurationMeasuredValueDefinition,
  ProductConfiguration,
  ProductConfigurationCurrentActivation,
  ProductConfigurationDefinitionRevision,
} from './product-configuration.ts';
import type { ProductRef } from '../resources/product.ts';
import type { VariantRef } from '../resources/variant.ts';

/** Caller-supplied, owner-qualified facts. This pure evaluator does not discover Current state. */
export interface ConfigurationValidationBasis {
  readonly assessedAt: CatalogRevisionInstant;
  readonly compatibilityCompleteness: 'COMPLETE' | 'UNKNOWN';
  readonly compatibilityRules: readonly CompatibilityRule[];
  readonly conversions?: readonly ConfigurationUnitConversion[];
  /** Owner read must attest the one applicable revision at this trusted operation time. */
  readonly current: ProductConfigurationCurrentActivation | null;
  readonly definition: ProductConfigurationDefinitionRevision | null;
  readonly measuredRules: Readonly<Record<string, MeasuredConstraint | null>>;
  readonly packageOptionRef?: CatalogResourceRef;
  readonly packageOptionVariantRef?: VariantRef;
  readonly targetCompleteness: 'COMPLETE' | 'UNKNOWN';
  readonly variantProductRef?: ProductRef | null;
  readonly variantRef?: VariantRef;
}

export type ConfigurationValidationResult =
  | {
      readonly assessedAt: CatalogRevisionInstant;
      readonly definitionRevision: CatalogSelectionRevision | undefined;
      readonly ruleRevisions: readonly ConfigurationRuleRevisionEvidence[];
      readonly status: 'VALID';
    }
  | {
      readonly assessedAt: CatalogRevisionInstant;
      readonly code: string;
      readonly definitionRevision: CatalogSelectionRevision | undefined;
      readonly ruleIds: readonly string[];
      readonly ruleRevisions: readonly ConfigurationRuleRevisionEvidence[];
      readonly status: 'INVALID' | 'INDETERMINATE';
    };

const sameRef = (left: CatalogResourceRef, right: CatalogResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId &&
  left.resourceId === right.resourceId;

const catalogOwnerModuleId = 'commerce.catalog' as const;

const ruleRevisions = (basis: ConfigurationValidationBasis): readonly ConfigurationRuleRevisionEvidence[] => {
  if (basis.definition === null) {
    return [];
  }
  const definitionRevision = basis.definition.reference;
  const choices = basis.definition.choices.map((choice) => ({
    definitionRevision,
    kind: 'CHOICE' as const,
    ownerModuleId: catalogOwnerModuleId,
    revision: definitionRevision.revision,
    ruleId: choice.choiceKey,
  }));
  const measured = Object.values(basis.measuredRules).flatMap((rule) =>
    rule === null
      ? []
      : [
          {
            definitionRevision,
            kind: 'MEASURED' as const,
            ownerModuleId: catalogOwnerModuleId,
            revision: rule.revision,
            ruleId: rule.ruleId,
          },
        ],
  );
  const compatibility = basis.compatibilityRules.map((rule) => ({
    definitionRevision,
    kind: 'COMPATIBILITY' as const,
    ownerModuleId: catalogOwnerModuleId,
    revision: rule.revision,
    ruleId: rule.ruleId,
  }));
  return [...choices, ...measured, ...compatibility];
};

const sameRuleRevisions = (
  expected: readonly ConfigurationRuleRevisionEvidence[],
  attested: readonly ConfigurationRuleRevisionEvidence[],
): boolean => {
  if (expected.length !== attested.length) {
    return false;
  }
  const used = new Set<number>();
  for (const rule of expected) {
    const index = attested.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) &&
        candidate.ownerModuleId === rule.ownerModuleId &&
        candidate.kind === rule.kind &&
        candidate.ruleId === rule.ruleId &&
        candidate.revision === rule.revision &&
        sameCatalogRevisionReference(candidate.definitionRevision, rule.definitionRevision),
    );
    if (index === -1) {
      return false;
    }
    used.add(index);
  }
  return true;
};

interface ChoiceScan {
  readonly chosen: Readonly<Record<string, ConfigurationValue>>;
  readonly decision:
    | { readonly code: string; readonly ruleIds: readonly string[]; readonly status: 'INVALID' | 'INDETERMINATE' }
    | undefined;
}

const checkMeasurement = (
  value: ConfigurationMeasuredValue,
  choice: ConfigurationMeasuredValueDefinition,
  basis: ConfigurationValidationBasis,
): ChoiceScan['decision'] => {
  if (
    value.unitRef.moduleId !== choice.unitRef.moduleId ||
    value.unitRef.resourceType !== choice.unitRef.resourceType ||
    value.unitRef.tenantId !== choice.unitRef.tenantId
  ) {
    return { code: 'INCOMPATIBLE_UNIT', ruleIds: [choice.choiceKey], status: 'INVALID' };
  }
  const rule = basis.measuredRules[value.choiceKey] ?? null;
  if (rule !== null && rule.unit !== choice.unitRef.resourceId) {
    return { code: 'MEASURED_RULE_UNIT_UNVERIFIED', ruleIds: [rule.ruleId], status: 'INDETERMINATE' };
  }
  const decision = evaluateMeasuredConstraint(
    { amount: value.amount, unit: value.unitRef.resourceId },
    rule,
    basis.conversions,
  );
  return decision.status === 'VALID' ? undefined : decision;
};

const checkTarget = (selection: ProductConfiguration, basis: ConfigurationValidationBasis): ChoiceScan['decision'] => {
  if (
    selection.variantRef.tenantId !== selection.productRef.tenantId ||
    (selection.packageOptionRef !== undefined && selection.packageOptionRef.tenantId !== selection.productRef.tenantId)
  ) {
    return { code: 'TARGET_TENANT_MISMATCH', ruleIds: [], status: 'INVALID' };
  }
  if (
    basis.variantProductRef !== undefined &&
    basis.variantProductRef !== null &&
    !sameRef(selection.productRef, basis.variantProductRef)
  ) {
    return { code: 'VARIANT_PRODUCT_MISMATCH', ruleIds: [], status: 'INVALID' };
  }
  if (basis.variantRef !== undefined && !sameRef(selection.variantRef, basis.variantRef)) {
    return { code: 'VARIANT_TARGET_UNVERIFIED', ruleIds: [], status: 'INDETERMINATE' };
  }
  if ((selection.packageOptionRef === undefined) !== (basis.packageOptionRef === undefined)) {
    return {
      code: 'PACKAGE_TARGET_MISMATCH',
      ruleIds: [],
      status: basis.targetCompleteness === 'COMPLETE' ? 'INVALID' : 'INDETERMINATE',
    };
  }
  if (
    selection.packageOptionRef !== undefined &&
    basis.packageOptionRef !== undefined &&
    !sameRef(selection.packageOptionRef, basis.packageOptionRef)
  ) {
    return { code: 'PACKAGE_TARGET_UNVERIFIED', ruleIds: [], status: 'INDETERMINATE' };
  }
  if (basis.packageOptionVariantRef !== undefined && !sameRef(selection.variantRef, basis.packageOptionVariantRef)) {
    return { code: 'PACKAGE_VARIANT_MISMATCH', ruleIds: [], status: 'INVALID' };
  }
  return undefined;
};

const scanChoices = (
  selection: ProductConfiguration,
  definition: ProductConfigurationDefinitionRevision,
  basis: ConfigurationValidationBasis,
): ChoiceScan => {
  const definitions = new Map(definition.choices.map((choice) => [choice.choiceKey, choice]));
  const chosen: Record<string, ConfigurationValue> = {};
  const seen = new Set<string>();
  let pending: ChoiceScan['decision'];
  for (const value of selection.values) {
    if (seen.has(value.choiceKey)) {
      return { chosen, decision: { code: 'DUPLICATE_CHOICE', ruleIds: [], status: 'INVALID' } };
    }
    seen.add(value.choiceKey);
    const choice = definitions.get(value.choiceKey);
    if (choice === undefined || choice.kind !== value.kind) {
      return {
        chosen,
        decision: {
          code: choice === undefined ? 'UNKNOWN_CHOICE' : 'WRONG_VALUE_KIND',
          ruleIds: [],
          status: 'INVALID',
        },
      };
    }
    if (choice.kind === 'SINGLE_CHOICE' && value.kind === 'SINGLE_CHOICE') {
      if (!choice.options.some((option) => option.optionKey === value.optionKey)) {
        return { chosen, decision: { code: 'UNKNOWN_OPTION', ruleIds: [], status: 'INVALID' } };
      }
      chosen[value.choiceKey] = { choiceId: value.optionKey, kind: 'SINGLE_CHOICE' };
    } else if (choice.kind === 'MEASURED_VALUE' && value.kind === 'MEASURED_VALUE') {
      const unit = value.unitRef.resourceId;
      chosen[value.choiceKey] = { amount: value.amount, kind: 'MEASURED_VALUE', unit };
      const decision = checkMeasurement(value, choice, basis);
      if (decision?.status === 'INVALID') {
        return { chosen, decision };
      }
      if (decision?.status === 'INDETERMINATE') {
        pending ??= decision;
      }
    }
  }
  for (const choice of definition.choices) {
    if (choice.required && !seen.has(choice.choiceKey)) {
      return { chosen, decision: { code: 'REQUIRED_CHOICE_MISSING', ruleIds: [choice.choiceKey], status: 'INVALID' } };
    }
  }
  return { chosen, decision: pending };
};

const assessRules = (
  selection: ProductConfiguration,
  basis: ConfigurationValidationBasis,
  scanned: ChoiceScan,
): ChoiceScan['decision'] => {
  if (scanned.decision?.status === 'INVALID') {
    return scanned.decision;
  }
  let pending = scanned.decision;
  const compatibility = evaluateCompatibilityRules(
    scanned.chosen,
    basis.compatibilityRules,
    basis.compatibilityCompleteness,
    basis.conversions,
  );
  if (compatibility.status === 'INVALID') {
    return compatibility;
  }
  if (compatibility.status === 'INDETERMINATE') {
    pending ??= compatibility;
  }
  if (
    selection.packageOptionRef !== undefined &&
    (basis.packageOptionVariantRef === undefined || basis.packageOptionRef === undefined)
  ) {
    pending ??= { code: 'PACKAGE_TARGET_UNVERIFIED', ruleIds: [], status: 'INDETERMINATE' };
  }
  if (
    basis.variantProductRef === undefined ||
    basis.variantProductRef === null ||
    basis.variantRef === undefined ||
    basis.targetCompleteness === 'UNKNOWN'
  ) {
    pending ??= { code: 'VARIANT_TARGET_UNVERIFIED', ruleIds: [], status: 'INDETERMINATE' };
  }
  return pending;
};

/** Exact selection validation only; purchase-line quantity and Current reads belong elsewhere. */
export const validateConfigurationSelection = (
  selection: ProductConfiguration,
  basis: ConfigurationValidationBasis,
): ConfigurationValidationResult => {
  const revision = basis.definition?.reference;
  const evidence = { assessedAt: basis.assessedAt, definitionRevision: revision, ruleRevisions: ruleRevisions(basis) };
  const invalid = (code: string, ruleIds: readonly string[] = []): ConfigurationValidationResult => ({
    ...evidence,
    code,
    ruleIds,
    status: 'INVALID',
  });
  const unknown = (code: string, ruleIds: readonly string[] = []): ConfigurationValidationResult => ({
    ...evidence,
    code,
    ruleIds,
    status: 'INDETERMINATE',
  });

  if (basis.definition === null || !sameCatalogRevisionReference(selection.definition, basis.definition.reference)) {
    return unknown('DEFINITION_REVISION_UNAVAILABLE');
  }
  if (!sameRef(selection.productRef, basis.definition.productRef)) {
    return invalid('WRONG_PRODUCT');
  }
  if (inspectConfigurationDefinition(basis.definition).status !== 'VALID') {
    return unknown('MALFORMED_DEFINITION');
  }
  const target = checkTarget(selection, basis);
  if (target?.status === 'INVALID') {
    return invalid(target.code, target.ruleIds);
  }
  if (target?.status === 'INDETERMINATE') {
    return unknown(target.code, target.ruleIds);
  }
  if (
    inspectProductConfigurationCurrentActivation(
      selection,
      basis.definition,
      basis.current ?? undefined,
      basis.assessedAt,
    ).status !== 'VALID' ||
    basis.current === null ||
    !sameRuleRevisions(evidence.ruleRevisions, basis.current.ruleRevisions)
  ) {
    return unknown('CURRENT_DEFINITION_UNVERIFIED');
  }

  const scanned = scanChoices(selection, basis.definition, basis);
  const decision = assessRules(selection, basis, scanned);
  if (decision?.status === 'INVALID') {
    return invalid(decision.code, decision.ruleIds);
  }
  if (decision !== undefined) {
    return unknown(decision.code, decision.ruleIds);
  }
  return { ...evidence, status: 'VALID' };
};
