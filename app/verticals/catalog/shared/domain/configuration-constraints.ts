/** Pure, exact Product Configuration decisions. No purchase-quantity normalization applies here. */
export interface ConfigurationMeasurement {
  readonly amount: string;
  readonly unit: string;
}

interface ConfigurationBound {
  readonly amount: string;
  readonly inclusive: boolean;
}

interface ConfigurationStep {
  readonly amount: string;
  readonly base: string;
}

export interface MeasuredConstraint {
  /** COMPLETE confirms that null bounds/step really are absent; UNKNOWN never means unrestricted. */
  readonly completeness: 'COMPLETE' | 'UNKNOWN';
  readonly maximum: ConfigurationBound | null;
  readonly minimum: ConfigurationBound | null;
  readonly revision: number;
  readonly ruleId: string;
  readonly step: ConfigurationStep | null;
  readonly unit: string;
}

export interface ConfigurationUnitConversion {
  readonly denominator: string;
  readonly evidenceId: string;
  readonly from: string;
  readonly numerator: string;
  readonly to: string;
}

export type ConstraintDecision =
  | { readonly ruleIds: readonly string[]; readonly status: 'VALID' }
  | { readonly code: string; readonly ruleIds: readonly string[]; readonly status: 'INVALID' }
  | { readonly code: string; readonly ruleIds: readonly string[]; readonly status: 'INDETERMINATE' };

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

const parseDecimal = (text: string): Decimal | null => {
  if (!DECIMAL.test(text) || text.length > 256) {
    return null;
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = unsigned.split('.');
  return { coefficient: BigInt(`${negative ? '-' : ''}${whole}${fraction}`), scale: fraction.length };
};

interface Rational {
  readonly denominator: bigint;
  readonly numerator: bigint;
}

const ratio = (value: Decimal): Rational => ({ denominator: 10n ** BigInt(value.scale), numerator: value.coefficient });
const convertRatio = (value: Decimal, conversion: ConfigurationUnitConversion): Rational | null => {
  const numerator = parseDecimal(conversion.numerator);
  const denominator = parseDecimal(conversion.denominator);
  if (numerator === null || denominator === null || numerator.coefficient <= 0n || denominator.coefficient <= 0n) {
    return null;
  }
  return {
    denominator: 10n ** BigInt(value.scale + numerator.scale) * denominator.coefficient,
    numerator: value.coefficient * numerator.coefficient * 10n ** BigInt(denominator.scale),
  };
};
const compareRatio = (left: Rational, right: Rational): number => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  if (difference < 0n) {
    return -1;
  }
  if (difference > 0n) {
    return 1;
  }
  return 0;
};
const subtractRatio = (left: Rational, right: Rational): Rational => ({
  denominator: left.denominator * right.denominator,
  numerator: left.numerator * right.denominator - right.numerator * left.denominator,
});

const checkBound = (
  value: Rational,
  bound: ConfigurationBound | null,
  direction: 'MINIMUM' | 'MAXIMUM',
  ids: readonly string[],
): ConstraintDecision | null => {
  if (bound === null) {
    return null;
  }
  const parsed = parseDecimal(bound.amount);
  if (parsed === null) {
    return { code: 'MALFORMED_BOUND', ruleIds: ids, status: 'INDETERMINATE' };
  }
  const comparison = compareRatio(value, ratio(parsed));
  const violated =
    direction === 'MINIMUM'
      ? comparison < 0 || (comparison === 0 && !bound.inclusive)
      : comparison > 0 || (comparison === 0 && !bound.inclusive);
  return violated ? { code: direction, ruleIds: ids, status: 'INVALID' } : null;
};

const checkStep = (
  value: Rational,
  stepRule: ConfigurationStep | null,
  ids: readonly string[],
): ConstraintDecision | null => {
  if (stepRule === null) {
    return null;
  }
  const step = parseDecimal(stepRule.amount);
  const base = parseDecimal(stepRule.base);
  if (step === null || base === null || step.coefficient <= 0n) {
    return { code: 'MALFORMED_STEP', ruleIds: ids, status: 'INDETERMINATE' };
  }
  const difference = subtractRatio(value, ratio(base));
  const increment = ratio(step);
  return (difference.numerator * increment.denominator) % (difference.denominator * increment.numerator) === 0n
    ? null
    : { code: 'OFF_STEP', ruleIds: ids, status: 'INVALID' };
};

const checkMeasuredLimits = (
  value: Rational,
  rule: MeasuredConstraint,
  ids: readonly string[],
): ConstraintDecision | null =>
  checkBound(value, rule.minimum, 'MINIMUM', ids) ??
  checkBound(value, rule.maximum, 'MAXIMUM', ids) ??
  checkStep(value, rule.step, ids);

const malformedMeasuredRule = (rule: MeasuredConstraint): boolean =>
  rule.ruleId.length === 0 || !Number.isSafeInteger(rule.revision) || rule.revision <= 0 || rule.unit.length === 0;

/** A known violation is decisive even when other limits are unknown. */
export const evaluateMeasuredConstraint = (
  value: ConfigurationMeasurement,
  rule: MeasuredConstraint | null,
  conversions: readonly ConfigurationUnitConversion[] = [],
): ConstraintDecision => {
  if (rule === null) {
    return { code: 'MISSING_MEASURED_RULE', ruleIds: [], status: 'INDETERMINATE' };
  }
  const ids = [rule.ruleId];
  const amount = parseDecimal(value.amount);
  if (amount === null || value.unit.length === 0) {
    return { code: 'MALFORMED_MEASUREMENT', ruleIds: ids, status: 'INVALID' };
  }
  if (malformedMeasuredRule(rule)) {
    return { code: 'MALFORMED_MEASURED_RULE', ruleIds: ids, status: 'INDETERMINATE' };
  }
  const matches = conversions.filter((item) => item.from === value.unit && item.to === rule.unit);
  if (value.unit !== rule.unit && matches.length > 1) {
    return { code: 'AMBIGUOUS_UNIT_CONVERSION', ruleIds: ids, status: 'INDETERMINATE' };
  }
  const conversion = value.unit === rule.unit ? null : matches[0];
  if (value.unit !== rule.unit && conversion === undefined) {
    return { code: 'INCOMPATIBLE_UNIT', ruleIds: ids, status: 'INVALID' };
  }
  if (conversion !== null && conversion !== undefined && conversion.evidenceId.length === 0) {
    return { code: 'UNVERIFIED_UNIT_CONVERSION', ruleIds: ids, status: 'INDETERMINATE' };
  }
  let exact: Rational | null = null;
  if (conversion === null) {
    exact = ratio(amount);
  } else if (conversion !== undefined) {
    exact = convertRatio(amount, conversion);
  }
  if (exact === null) {
    return { code: 'MALFORMED_UNIT_CONVERSION', ruleIds: ids, status: 'INDETERMINATE' };
  }
  const limit = checkMeasuredLimits(exact, rule, ids);
  if (limit !== null) {
    return limit;
  }
  return rule.completeness === 'COMPLETE'
    ? { ruleIds: ids, status: 'VALID' }
    : { code: 'UNKNOWN_MEASURED_RULE', ruleIds: ids, status: 'INDETERMINATE' };
};

export type ConfigurationValue =
  | { readonly choiceId: string; readonly kind: 'SINGLE_CHOICE' }
  | { readonly amount: string; readonly kind: 'MEASURED_VALUE'; readonly unit: string };

interface ForbiddenChoiceCombination {
  readonly choices: Readonly<Record<string, string>>;
  readonly kind: 'FORBIDDEN_CHOICE_COMBINATION';
  readonly revision: number;
  readonly ruleId: string;
}

interface ChoiceMeasuredMaximum {
  readonly choiceId: string;
  readonly choiceKey: string;
  readonly kind: 'CHOICE_MEASURED_MAXIMUM';
  readonly maximum: ConfigurationBound;
  readonly measuredKey: string;
  readonly revision: number;
  readonly ruleId: string;
  readonly unit: string;
}

export type CompatibilityRule = ForbiddenChoiceCombination | ChoiceMeasuredMaximum;

const checkCompatibilityRule = (
  selected: Readonly<Record<string, ConfigurationValue>>,
  rule: CompatibilityRule,
  conversions: readonly ConfigurationUnitConversion[],
): ConstraintDecision | null => {
  if (rule.kind === 'FORBIDDEN_CHOICE_COMBINATION') {
    const entries = Object.entries(rule.choices);
    if (entries.length < 2 || entries.some(([key, id]) => key.length === 0 || id.length === 0)) {
      return { code: 'MALFORMED_COMPATIBILITY_RULE', ruleIds: [rule.ruleId], status: 'INDETERMINATE' };
    }
    return entries.every(([key, id]) => selected[key]?.kind === 'SINGLE_CHOICE' && selected[key].choiceId === id)
      ? { code: 'FORBIDDEN_COMBINATION', ruleIds: [rule.ruleId], status: 'INVALID' }
      : null;
  }
  const choice = selected[rule.choiceKey];
  const measured = selected[rule.measuredKey];
  if (choice?.kind !== 'SINGLE_CHOICE' || choice.choiceId !== rule.choiceId || measured?.kind !== 'MEASURED_VALUE') {
    return null;
  }
  const decision = evaluateMeasuredConstraint(
    measured,
    {
      completeness: 'COMPLETE',
      maximum: rule.maximum,
      minimum: null,
      revision: rule.revision,
      ruleId: rule.ruleId,
      step: null,
      unit: rule.unit,
    },
    conversions,
  );
  if (decision.status === 'VALID') {
    return null;
  }
  if (decision.status === 'INVALID') {
    return { ...decision, code: 'INCOMPATIBLE_COMBINATION' };
  }
  return decision;
};

/** Closed rule vocabulary; absence is valid only with explicit complete-set evidence. */
export const evaluateCompatibilityRules = (
  selected: Readonly<Record<string, ConfigurationValue>>,
  rules: readonly CompatibilityRule[],
  completeness: 'COMPLETE' | 'UNKNOWN',
  conversions: readonly ConfigurationUnitConversion[] = [],
): ConstraintDecision => {
  const ids: string[] = [];
  let uncertain = completeness === 'UNKNOWN';
  for (const rule of rules) {
    ids.push(rule.ruleId);
    if (rule.ruleId.length === 0 || !Number.isSafeInteger(rule.revision) || rule.revision <= 0) {
      uncertain = true;
    } else {
      const decision = checkCompatibilityRule(selected, rule, conversions);
      if (decision?.status === 'INVALID') {
        return decision;
      }
      if (decision?.status === 'INDETERMINATE') {
        uncertain = true;
      }
    }
  }
  return uncertain
    ? { code: 'UNKNOWN_COMPATIBILITY_RULE', ruleIds: ids, status: 'INDETERMINATE' }
    : { ruleIds: ids, status: 'VALID' };
};
