import { Equal, Schema } from 'effect';

import { CatalogResourceRefSchema } from './catalog-revision-reference.ts';

const AttributeDefinitionRefSchema = CatalogResourceRefSchema.check(
  Schema.makeFilter((ref) =>
    ref.resourceType === 'commerce.catalog.attribute-definition' ? undefined : 'Expected an Attribute Definition',
  ),
);
const ControlledValueRefSchema = CatalogResourceRefSchema.check(
  Schema.makeFilter((ref) =>
    ref.resourceType === 'commerce.catalog.controlled-attribute-value' ? undefined : 'Expected a controlled value',
  ),
);
const finiteNumber = Schema.Number.check(Schema.isFinite());
const SpecialStateSchema = Schema.Literals(['UNKNOWN', 'NONE', 'NOT_APPLICABLE']);

/** A shared definition asks one stable question; its label is not its identity. */
export const AttributeDefinitionSchema = Schema.Struct({
  label: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
  levels: Schema.Array(Schema.Literals(['PRODUCT', 'VARIANT'])),
  meaning: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
  measurement: Schema.optionalKey(
    Schema.Struct({
      canonicalUnit: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
      decimalPlaces: Schema.Number.check(Schema.isInt(), Schema.isBetween({ maximum: 12, minimum: 0 })),
      maximum: Schema.optionalKey(finiteNumber),
      minimum: Schema.optionalKey(finiteNumber),
      quantity: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
    }),
  ),
  multiplicity: Schema.Literals(['SINGLE', 'MULTIPLE']),
  ref: AttributeDefinitionRefSchema,
  specialStates: Schema.Array(SpecialStateSchema),
  valueKind: Schema.Literals(['TEXT', 'CONTROLLED', 'MEASUREMENT']),
}).check(
  Schema.makeFilter((definition) => {
    if (definition.levels.length === 0 || new Set(definition.levels).size !== definition.levels.length) {
      return 'A definition needs distinct applicable levels';
    }
    if ((definition.valueKind === 'MEASUREMENT') !== (definition.measurement !== undefined)) {
      return 'Only measured definitions have measurement rules';
    }
    if (
      definition.measurement !== undefined &&
      definition.measurement.minimum !== undefined &&
      definition.measurement.maximum !== undefined &&
      definition.measurement.minimum > definition.measurement.maximum
    ) {
      return 'Measurement minimum cannot exceed maximum';
    }
    return new Set(definition.specialStates).size === definition.specialStates.length
      ? undefined
      : 'Special states cannot repeat';
  }),
);
export type AttributeDefinition = typeof AttributeDefinitionSchema.Type;

export interface DefinitionRuleChangeAssessment {
  readonly kind: 'UNCHANGED' | 'RULE_REVISION' | 'NEW_DEFINITION_REQUIRED';
  readonly reasons: readonly string[];
}

const identityAndMeaning = (definition: AttributeDefinition) => [
  definition.ref.tenantId,
  definition.ref.resourceId,
  definition.meaning,
  definition.valueKind,
  definition.measurement?.quantity,
];
const ruleFields = (definition: AttributeDefinition) => [
  definition.multiplicity,
  definition.measurement?.canonicalUnit,
  definition.measurement?.decimalPlaces,
  [definition.measurement?.minimum, definition.measurement?.maximum],
  [...definition.levels].toSorted(),
  [...definition.specialStates].toSorted(),
];

/** A rule revision can retain identity only when the question being answered stays the same. */
export const assessDefinitionRuleChange = (
  current: AttributeDefinition,
  proposed: AttributeDefinition,
): DefinitionRuleChangeAssessment => {
  if (!Schema.is(AttributeDefinitionSchema)(current) || !Schema.is(AttributeDefinitionSchema)(proposed)) {
    return { kind: 'NEW_DEFINITION_REQUIRED', reasons: ['Invalid definition'] };
  }
  if (!Equal.equals(identityAndMeaning(current), identityAndMeaning(proposed))) {
    return { kind: 'NEW_DEFINITION_REQUIRED', reasons: ['The measured or described meaning changed'] };
  }
  const before = ruleFields(current);
  const after = ruleFields(proposed);
  const names = [
    'Multiplicity changed',
    'Canonical unit changed',
    'Precision changed',
    'Range changed',
    'Applicable levels changed',
    'Special states changed',
  ];
  const reasons = names.filter((_, index) => !Equal.equals(before[index], after[index]));
  return { kind: reasons.length === 0 ? 'UNCHANGED' : 'RULE_REVISION', reasons };
};

/** Absence is represented by no values, never by a fabricated zero, blank, or special state. */
export const AttributeValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('TEXT'), text: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()) }),
  Schema.Struct({ kind: Schema.Literal('CONTROLLED'), valueRef: ControlledValueRefSchema }),
  Schema.Struct({
    amount: finiteNumber,
    kind: Schema.Literal('MEASUREMENT'),
    unit: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
  }),
  Schema.Struct({ kind: Schema.Literal('SPECIAL'), state: SpecialStateSchema }),
]);
export type AttributeValue = typeof AttributeValueSchema.Type;

/** A proposed conversion; only owner-known exact relationships can authorize it. */
export interface UnitConversion {
  readonly denominator: number;
  readonly from: string;
  readonly numerator: number;
  readonly quantity: string;
  readonly to: string;
}

// Catalog-owned exact relationships. Request payloads cannot establish unit semantics.
export const trustedUnitConversions: readonly UnitConversion[] = [
  { denominator: 1, from: 'cm', numerator: 10, quantity: 'length', to: 'mm' },
  { denominator: 10, from: 'mm', numerator: 1, quantity: 'length', to: 'cm' },
];

interface Rational {
  readonly denominator: bigint;
  readonly numerator: bigint;
}

/** Number.toString preserves the entered decimal value, including exponent notation. */
const decimalRatio = (value: number): Rational => {
  const [mantissa = '', exponentText = '0'] = value.toString().toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const fractionalDigits = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const exponent = Number(exponentText) - fractionalDigits;
  const signed = BigInt(digits) * (negative ? -1n : 1n);
  if (exponent >= 0) {
    return { denominator: 1n, numerator: signed * 10n ** BigInt(exponent) };
  }
  return { denominator: 10n ** BigInt(-exponent), numerator: signed };
};

const compareRatios = (left: Rational, right: Rational): number => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  if (difference < 0n) {
    return -1;
  }
  if (difference > 0n) {
    return 1;
  }
  return 0;
};

interface AttributeValidation {
  readonly normalized: readonly AttributeValue[];
  readonly reasons: readonly string[];
  readonly valid: boolean;
}

type ValueResult = { readonly reason: string } | { readonly normalized: AttributeValue; readonly reason?: string };

const validatedConversion = (
  unit: string,
  rule: NonNullable<AttributeDefinition['measurement']>,
  conversions: readonly UnitConversion[],
): { readonly factor: Rational } | { readonly reason: string } => {
  if (unit === rule.canonicalUnit) {
    return { factor: { denominator: 1n, numerator: 1n } };
  }
  const conversion = conversions.find(
    (item) => item.from === unit && item.to === rule.canonicalUnit && item.quantity === rule.quantity,
  );
  if (conversion === undefined) {
    return { reason: 'No evidenced compatible unit conversion' };
  }
  if (
    !Number.isFinite(conversion.numerator) ||
    !Number.isFinite(conversion.denominator) ||
    conversion.numerator <= 0 ||
    conversion.denominator <= 0
  ) {
    return { reason: 'Invalid unit conversion' };
  }
  const numerator = decimalRatio(conversion.numerator);
  const denominator = decimalRatio(conversion.denominator);
  const factor = {
    denominator: numerator.denominator * denominator.numerator,
    numerator: numerator.numerator * denominator.denominator,
  };
  const trusted = trustedUnitConversions.find(
    (item) => item.from === conversion.from && item.to === conversion.to && item.quantity === conversion.quantity,
  );
  if (
    trusted === undefined ||
    compareRatios(factor, { denominator: BigInt(trusted.denominator), numerator: BigInt(trusted.numerator) }) !== 0
  ) {
    return { reason: 'No evidenced compatible unit conversion' };
  }
  return { factor };
};

const validateMeasurement = (
  value: Extract<AttributeValue, { readonly kind: 'MEASUREMENT' }>,
  rule: NonNullable<AttributeDefinition['measurement']>,
  conversions: readonly UnitConversion[],
): ValueResult => {
  const conversion = validatedConversion(value.unit, rule, conversions);
  if ('reason' in conversion) {
    return conversion;
  }
  const source = decimalRatio(value.amount);
  const amount = {
    denominator: source.denominator * conversion.factor.denominator,
    numerator: source.numerator * conversion.factor.numerator,
  };
  if (
    (rule.minimum !== undefined && compareRatios(amount, decimalRatio(rule.minimum)) < 0) ||
    (rule.maximum !== undefined && compareRatios(amount, decimalRatio(rule.maximum)) > 0)
  ) {
    return { reason: 'Measurement is outside its valid range' };
  }
  const scaled = amount.numerator * 10n ** BigInt(rule.decimalPlaces);
  if (scaled % amount.denominator !== 0n) {
    return { reason: 'Measurement loses required precision' };
  }
  const scaledInteger = scaled / amount.denominator;
  if (scaledInteger > BigInt(Number.MAX_SAFE_INTEGER) || scaledInteger < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { reason: 'Measurement exceeds exact numeric precision' };
  }
  return {
    normalized: {
      amount: Number(scaledInteger) / 10 ** rule.decimalPlaces,
      kind: 'MEASUREMENT',
      unit: rule.canonicalUnit,
    },
  };
};

const validateValue = (
  definition: AttributeDefinition,
  value: AttributeValue | null,
  specialStates: ReadonlySet<AttributeDefinition['specialStates'][number]>,
  conversions: readonly UnitConversion[],
): ValueResult => {
  if (!Schema.is(AttributeValueSchema)(value)) {
    return { reason: 'Malformed value' };
  }
  if (value.kind === 'SPECIAL') {
    return specialStates.has(value.state)
      ? { normalized: value }
      : { normalized: value, reason: 'Special state is not allowed' };
  }
  if (value.kind !== definition.valueKind) {
    return { reason: 'Value kind differs from definition' };
  }
  if (value.kind === 'CONTROLLED') {
    return value.valueRef.tenantId === definition.ref.tenantId
      ? { normalized: value }
      : { normalized: value, reason: 'Controlled value belongs to another Tenant' };
  }
  if (value.kind === 'TEXT') {
    return { normalized: value };
  }
  if (definition.measurement === undefined) {
    return { reason: 'Measurement rules are missing' };
  }
  return validateMeasurement(value, definition.measurement, conversions);
};

/** Pure per-subject validation; Product Type owns required/optional and applicability. */
export const validateAttributeValues = (
  definition: AttributeDefinition,
  values: readonly (AttributeValue | null)[],
  conversions: readonly UnitConversion[] = [],
): AttributeValidation => {
  const reasons: string[] = [];
  const normalized: AttributeValue[] = [];
  if (!Schema.is(AttributeDefinitionSchema)(definition)) {
    return { normalized, reasons: ['Invalid definition'], valid: false };
  }
  if (definition.multiplicity === 'SINGLE' && values.length > 1) {
    reasons.push('Single attribute has multiple values');
  }
  if (values.some((value) => Schema.is(AttributeValueSchema)(value) && value.kind === 'SPECIAL') && values.length > 1) {
    reasons.push('A special state cannot coexist with another value');
  }
  const specialStates = new Set(definition.specialStates);
  for (const value of values) {
    const result = validateValue(definition, value, specialStates, conversions);
    if ('reason' in result && result.reason !== undefined) {
      reasons.push(result.reason);
    }
    if ('normalized' in result) {
      normalized.push(result.normalized);
    }
  }
  return { normalized, reasons, valid: reasons.length === 0 };
};
