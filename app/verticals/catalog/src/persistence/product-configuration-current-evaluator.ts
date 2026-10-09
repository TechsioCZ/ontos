import { DateTime, Effect, Option } from 'effect';

import type { ConfigurationUnitRevision } from '../../shared/domain/configuration-unit.ts';
import { evaluateMeasuredConstraint } from '../../shared/domain/configuration-constraints.ts';
import type { ConstraintDecision, MeasuredConstraint } from '../../shared/domain/configuration-constraints.ts';
import { inspectProductConfigurationRuleConsistency } from './product-configuration-persistence.ts';
import type {
  ConfigurationCompatibilityRuleInput,
  ConfigurationMeasuredRuleInput,
  ConfigurationOptionAllowanceInput,
  ConfigurationTargetInput,
  CurrentConfigurationRevision,
  ProductConfigurationPersistence,
} from './product-configuration-persistence.ts';

const MODULE_KEY = 'commerce.catalog' as const;

/** The caller has already proven these exact tenant-local target relationships. */
export interface TrustedConfigurationTarget {
  readonly definitionId: string;
  readonly packageDefinitionId?: string;
  readonly productId: string;
  readonly variantId: string;
}

export type CurrentConfigurationValue =
  | { readonly choiceKey: string; readonly kind: 'SINGLE_CHOICE'; readonly optionKey: string }
  | { readonly amount: string; readonly choiceKey: string; readonly kind: 'MEASURED_VALUE'; readonly unitId: string };

export interface CurrentConfigurationAssessmentInput {
  /** Trusted operation time, not a customer-supplied timestamp. */
  readonly at: Date;
  readonly target: TrustedConfigurationTarget;
  readonly values: readonly CurrentConfigurationValue[];
}

interface CurrentConfigurationRuleEvidence {
  /** Exact owner Definition revision the rule was read from; absent evidence is never assumed. */
  readonly definitionRevision?: number;
  readonly evidenceRefs: readonly string[];
  /** Source kind recorded by the owner; it is not inferred from the rule ID's spelling. */
  readonly kind?: 'CHOICE' | 'COMPATIBILITY' | 'MEASURED';
  readonly ownerModuleId?: string;
  readonly revision: number;
  readonly ruleId: string;
}

/** Exact owner-recorded meanings, not a claim about external Attribute or Unit Current state. */
interface CurrentConfigurationChoiceEvidence {
  readonly choiceKey: string;
  readonly evidenceRefs: readonly string[];
  readonly kind: 'SINGLE_CHOICE' | 'MEASURED_VALUE';
  readonly meaning: string;
  readonly options: readonly { readonly meaning: string; readonly optionKey: string }[];
  readonly ownerModuleId: typeof MODULE_KEY;
  readonly required: boolean;
  readonly revision: number;
  readonly unitId?: string;
  readonly unitRevision?: number;
}

export type CurrentConfigurationAssessment = {
  readonly assessedAt: Date;
  readonly choiceRevisions: readonly CurrentConfigurationChoiceEvidence[];
  readonly definitionId: string;
  readonly definitionRevision?: number;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date;
  readonly rules: readonly CurrentConfigurationRuleEvidence[];
  readonly target: TrustedConfigurationTarget;
  readonly unitRevisions: readonly ConfigurationUnitRevision[];
} & (
  | { readonly status: 'VALID' }
  | { readonly code: string; readonly ruleIds: readonly string[]; readonly status: 'INVALID' | 'INDETERMINATE' }
);

const applies = (rule: ConfigurationTargetInput, target: TrustedConfigurationTarget): boolean =>
  (rule.variantId === undefined || rule.variantId === target.variantId) &&
  (rule.packageDefinitionId === undefined || rule.packageDefinitionId === target.packageDefinitionId);

const targetSuffix = (rule: ConfigurationTargetInput): string =>
  `${rule.variantId ?? 'product'}:${rule.packageDefinitionId ?? 'all-packages'}`;

const measuredId = (choiceKey: string, rule: ConfigurationTargetInput): string =>
  `measured:${choiceKey}:${targetSuffix(rule)}`;
const allowanceId = (choiceKey: string, optionKey: string, rule: ConfigurationTargetInput): string =>
  `allowance:${choiceKey}:${optionKey}:${targetSuffix(rule)}`;

const selected = (values: readonly CurrentConfigurationValue[], key: string): CurrentConfigurationValue | undefined =>
  values.find((value) => value.choiceKey === key);

const conditional = (
  rule: ConfigurationCompatibilityRuleInput,
  values: readonly CurrentConfigurationValue[],
  unitId: string | undefined,
  revision: number,
): ConstraintDecision | null => {
  const choice = selected(values, rule.choiceKey);
  if (choice?.kind !== 'SINGLE_CHOICE' || choice.optionKey !== rule.optionKey) {
    return null;
  }
  const other = selected(values, rule.otherChoiceKey);
  if (rule.kind === 'FORBIDDEN_PAIR') {
    return other?.kind === 'SINGLE_CHOICE' && other.optionKey === rule.otherOptionKey
      ? { code: 'FORBIDDEN_COMBINATION', ruleIds: [rule.ruleId], status: 'INVALID' }
      : null;
  }
  if (other?.kind !== 'MEASURED_VALUE' || unitId === undefined || rule.maximum === undefined) {
    return null;
  }
  const result = evaluateMeasuredConstraint(
    { amount: other.amount, unit: other.unitId },
    {
      completeness: 'COMPLETE',
      maximum: { amount: rule.maximum, inclusive: rule.maximumInclusive === true },
      minimum: null,
      revision,
      ruleId: rule.ruleId,
      step: null,
      unit: unitId,
    },
  );
  return result.status === 'INVALID' ? { ...result, code: 'INCOMPATIBLE_COMBINATION' } : result;
};

const applicableRules = (revision: CurrentConfigurationRevision, target: TrustedConfigurationTarget) => {
  const allowances = revision.optionAllowances.filter((rule) => applies(rule, target));
  const measured = revision.measuredRules.filter((rule) => applies(rule, target));
  const compatibility = revision.compatibilityRules.filter((rule) => applies(rule, target));
  const definitionRevision = revision.revision;
  const owner: Omit<CurrentConfigurationRuleEvidence, 'evidenceRefs' | 'kind' | 'ruleId'> = {
    definitionRevision,
    ownerModuleId: MODULE_KEY,
    revision: revision.revision,
  };
  const evidence: CurrentConfigurationRuleEvidence[] = [
    ...revision.choices.flatMap((choice) => [
      {
        ...owner,
        evidenceRefs: revision.definitionEvidenceRefs,
        kind: 'CHOICE' as const,
        ruleId: `choice:${choice.choiceKey}`,
      },
      ...(choice.options ?? []).map((option) => ({
        ...owner,
        evidenceRefs: revision.definitionEvidenceRefs,
        kind: 'CHOICE' as const,
        ruleId: `option:${choice.choiceKey}:${option.optionKey}`,
      })),
    ]),
    ...allowances.map((rule) => ({
      ...owner,
      evidenceRefs: rule.evidenceRefs,
      kind: 'CHOICE' as const,
      ruleId: allowanceId(rule.choiceKey, rule.optionKey, rule),
    })),
    ...measured.map((rule) => ({
      ...owner,
      evidenceRefs: rule.evidenceRefs,
      kind: 'MEASURED' as const,
      ruleId: measuredId(rule.choiceKey, rule),
    })),
    ...compatibility.map((rule) => ({
      ...owner,
      evidenceRefs: rule.evidenceRefs,
      kind: 'COMPATIBILITY' as const,
      ruleId: rule.ruleId,
    })),
  ];
  return { allowances, compatibility, evidence, measured };
};

type ApplicableRules = ReturnType<typeof applicableRules>;
interface Decision {
  readonly code: string;
  readonly ruleIds: readonly string[];
  readonly status: 'INVALID' | 'INDETERMINATE';
}
const invalidDecision = (code: string, ruleIds: readonly string[] = []): Decision => ({
  code,
  ruleIds,
  status: 'INVALID',
});
const unknownDecision = (code: string, ruleIds: readonly string[] = []): Decision => ({
  code,
  ruleIds,
  status: 'INDETERMINATE',
});

const measure = (
  value: Extract<CurrentConfigurationValue, { kind: 'MEASURED_VALUE' }>,
  rules: readonly ConfigurationMeasuredRuleInput[],
  unitId: string,
  revision: number,
): Decision | undefined => {
  if (value.unitId !== unitId) {
    return invalidDecision('INCOMPATIBLE_UNIT');
  }
  const applicable = rules.filter((rule) => rule.choiceKey === value.choiceKey);
  if (applicable.length === 0) {
    return unknownDecision('MEASURED_RULE_UNAVAILABLE');
  }
  let pending: Decision | undefined;
  for (const rule of applicable) {
    const constraint: MeasuredConstraint = {
      completeness: 'COMPLETE',
      maximum: rule.maximum === undefined ? null : { amount: rule.maximum, inclusive: rule.maximumInclusive === true },
      minimum: rule.minimum === undefined ? null : { amount: rule.minimum, inclusive: rule.minimumInclusive === true },
      revision,
      ruleId: measuredId(value.choiceKey, rule),
      step: rule.step === undefined || rule.stepBase === undefined ? null : { amount: rule.step, base: rule.stepBase },
      unit: unitId,
    };
    const result = evaluateMeasuredConstraint({ amount: value.amount, unit: value.unitId }, constraint);
    if (result.status === 'INVALID') {
      return result;
    }
    if (result.status === 'INDETERMINATE') {
      pending ??= result;
    }
  }
  return pending;
};

const choiceDecision = (
  value: CurrentConfigurationValue,
  choice: CurrentConfigurationRevision['choices'][number] | undefined,
  allowances: readonly ConfigurationOptionAllowanceInput[],
  measured: readonly ConfigurationMeasuredRuleInput[],
  revision: number,
): Decision | undefined => {
  if (choice === undefined) {
    return invalidDecision('UNKNOWN_CHOICE');
  }
  if (choice.kind !== value.kind) {
    return invalidDecision('WRONG_VALUE_KIND');
  }
  if (value.kind === 'MEASURED_VALUE') {
    return measure(value, measured, choice.unitId ?? '', revision);
  }
  if (choice.options?.some((option) => option.optionKey === value.optionKey) !== true) {
    return invalidDecision('UNKNOWN_OPTION');
  }
  const applicable = allowances.filter(
    (rule) => rule.choiceKey === value.choiceKey && rule.optionKey === value.optionKey,
  );
  if (applicable.length === 0) {
    return unknownDecision('OPTION_ALLOWANCE_UNAVAILABLE');
  }
  const denied = applicable.find((rule) => !rule.allowed);
  return denied === undefined
    ? undefined
    : invalidDecision('OPTION_NOT_ALLOWED', [allowanceId(value.choiceKey, value.optionKey, denied)]);
};

const assess = (
  revision: CurrentConfigurationRevision,
  matching: ApplicableRules,
  values: readonly CurrentConfigurationValue[],
): Decision | undefined => {
  const definitions = new Map(revision.choices.map((choice) => [choice.choiceKey, choice]));
  const seen = new Set<string>();
  let pending: Decision | undefined;
  for (const value of values) {
    if (seen.has(value.choiceKey)) {
      return invalidDecision('DUPLICATE_CHOICE');
    }
    seen.add(value.choiceKey);
    const decision = choiceDecision(
      value,
      definitions.get(value.choiceKey),
      matching.allowances,
      matching.measured,
      revision.revision,
    );
    if (decision?.status === 'INVALID') {
      return decision;
    }
    pending ??= decision;
  }
  for (const choice of revision.choices) {
    if (choice.required && !seen.has(choice.choiceKey)) {
      return invalidDecision('REQUIRED_CHOICE_MISSING', [choice.choiceKey]);
    }
  }
  for (const rule of matching.compatibility) {
    const decision = conditional(rule, values, definitions.get(rule.otherChoiceKey)?.unitId, revision.revision);
    if (decision?.status === 'INVALID') {
      return decision;
    }
    if (decision?.status === 'INDETERMINATE') {
      pending ??= decision;
    }
  }
  return pending;
};

const currentAt = (revision: CurrentConfigurationRevision, input: CurrentConfigurationAssessmentInput): boolean => {
  const at = DateTime.make(input.at);
  if (Option.isNone(at)) {
    return false;
  }
  const instant = DateTime.toEpochMillis(at.value);
  return (
    revision.productId === input.target.productId &&
    revision.definitionId === input.target.definitionId &&
    revision.ruleCombination === 'CONJUNCTION_ONLY' &&
    DateTime.toEpochMillis(DateTime.makeUnsafe(revision.effectiveFrom)) <= instant &&
    (revision.effectiveTo === undefined || instant < DateTime.toEpochMillis(DateTime.makeUnsafe(revision.effectiveTo)))
  );
};

const unitEvidenceCurrent = (revision: CurrentConfigurationRevision, at: Date): boolean =>
  revision.choices.every((choice) => {
    if (choice.kind !== 'MEASURED_VALUE') {
      return true;
    }
    const unit = revision.units.find((item) => item.ref.resourceId === choice.unitId);
    return (
      choice.unitId !== undefined &&
      choice.unitRevision !== undefined &&
      unit !== undefined &&
      unit.ref.moduleId === MODULE_KEY &&
      unit.ref.resourceType === 'commerce.catalog.unit' &&
      unit.revision === choice.unitRevision &&
      unit.lifecycleState === 'ACTIVE' &&
      unit.evidenceRefs.length > 0 &&
      unit.effectiveFrom <= at &&
      (unit.effectiveTo === undefined || at < unit.effectiveTo)
    );
  });

const rulesCurrent = (revision: CurrentConfigurationRevision): boolean =>
  inspectProductConfigurationRuleConsistency(revision) === null;
const currentIssue = (
  revision: CurrentConfigurationRevision,
  input: CurrentConfigurationAssessmentInput,
): string | null => {
  if (!currentAt(revision, input)) {
    return 'CURRENT_DEFINITION_UNVERIFIED';
  }
  return rulesCurrent(revision) ? null : 'CURRENT_RULES_UNVERIFIED';
};

/** Reads one owner-confirmed Current revision; no Selection proof or purchase permission is issued. */
export const evaluateCurrentProductConfiguration = Effect.fn('ProductConfigurationCurrentEvaluator.evaluate')(
  function* evaluateCurrentProductConfiguration(
    persistence: Pick<ProductConfigurationPersistence, 'readCurrent'>,
    input: CurrentConfigurationAssessmentInput,
  ) {
    const current = yield* persistence.readCurrent({
      at: input.at,
      definitionId: input.target.definitionId,
      productId: input.target.productId,
    });
    const revision = Option.isSome(current) ? current.value : undefined;
    const matching = revision === undefined ? undefined : applicableRules(revision, input.target);
    const evidence: CurrentConfigurationAssessment = {
      assessedAt: input.at,
      choiceRevisions:
        revision?.choices.map((choice) => {
          const attested: CurrentConfigurationChoiceEvidence = {
            choiceKey: choice.choiceKey,
            evidenceRefs: revision.definitionEvidenceRefs,
            kind: choice.kind,
            meaning: choice.meaning,
            options: (choice.options ?? []).map((option) => ({ meaning: option.meaning, optionKey: option.optionKey })),
            ownerModuleId: MODULE_KEY,
            required: choice.required,
            revision: revision.revision,
          };
          if (choice.unitId !== undefined) {
            Object.assign(attested, { unitId: choice.unitId });
          }
          if (choice.unitRevision !== undefined) {
            Object.assign(attested, { unitRevision: choice.unitRevision });
          }
          return attested;
        }) ?? [],
      definitionId: input.target.definitionId,
      rules: matching?.evidence ?? [],
      status: 'VALID',
      target: input.target,
      unitRevisions: revision?.units ?? [],
    };
    if (revision !== undefined) {
      Object.assign(evidence, { definitionRevision: revision.revision, effectiveFrom: revision.effectiveFrom });
      if (revision.effectiveTo !== undefined) {
        Object.assign(evidence, { effectiveTo: revision.effectiveTo });
      }
    }
    const invalid = (code: string, ruleIds: readonly string[] = []): CurrentConfigurationAssessment => ({
      ...evidence,
      code,
      ruleIds,
      status: 'INVALID',
    });
    const unknown = (code: string, ruleIds: readonly string[] = []): CurrentConfigurationAssessment => ({
      ...evidence,
      code,
      ruleIds,
      status: 'INDETERMINATE',
    });
    if (revision === undefined) {
      return unknown('CURRENT_DEFINITION_UNAVAILABLE');
    }
    const issue = currentIssue(revision, input);
    if (issue !== null) {
      return unknown(issue);
    }
    if (revision.definitionEvidenceRefs.length === 0) {
      return unknown('CHOICE_REVISION_UNVERIFIED');
    }
    if (!unitEvidenceCurrent(revision, input.at)) {
      return unknown('CONFIGURATION_UNIT_REVISION_UNVERIFIED');
    }
    const decision = assess(revision, matching ?? applicableRules(revision, input.target), input.values);
    if (decision?.status === 'INVALID') {
      return invalid(decision.code, decision.ruleIds);
    }
    if (decision?.status === 'INDETERMINATE') {
      return unknown(decision.code, decision.ruleIds);
    }
    return { ...evidence, status: 'VALID' } satisfies CurrentConfigurationAssessment;
  },
);
