import { isDeepStrictEqual } from 'node:util';

import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { ConfigurationUnitRevision } from '../../shared/domain/configuration-unit.ts';

import {
  productConfigurationChoiceOptions,
  productConfigurationChoices,
  productConfigurationCompatibilityRules,
  productConfigurationDefinitionRevisions,
  productConfigurationDefinitions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  products,
} from '../database/schema.ts';
import { configurationUnitPersistenceForScope } from './configuration-unit-persistence.ts';
import type { ConfigurationUnitPersistence } from './configuration-unit-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class ProductConfigurationPersistenceUnavailable extends Schema.TaggedError<ProductConfigurationPersistenceUnavailable>()(
  'ProductConfigurationPersistenceUnavailable',
  { code: Schema.Literal('product_configuration_persistence_unavailable'), reason: Schema.String },
) {}

interface ConfigurationRuleSnapshot {
  readonly choices: PublishProductConfigurationInput['choices'];
  readonly compatibilityRules: PublishProductConfigurationInput['compatibilityRules'];
  readonly measuredRules: PublishProductConfigurationInput['measuredRules'];
  readonly optionAllowances: PublishProductConfigurationInput['optionAllowances'];
}

export interface ConfigurationSelectionImpact {
  /** Owner-issued proof, including existing open selections; unavailable evidence fails closed. */
  readonly verify: (input: {
    readonly definitionId: string;
    readonly effectiveFrom: Date;
    readonly previousRevision: number;
    readonly productId: string;
    readonly proposed: ConfigurationRuleSnapshot;
    readonly proposedRevision: number;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, ProductConfigurationPersistenceUnavailable>;
}

interface ConfigurationChoiceInput {
  readonly choiceKey: string;
  readonly kind: 'SINGLE_CHOICE' | 'MEASURED_VALUE';
  readonly label: string;
  readonly meaning: string;
  readonly options?: readonly { readonly label: string; readonly meaning: string; readonly optionKey: string }[];
  readonly required: boolean;
  readonly unitId?: string;
  /** Only populated by the owner read; publication derives this from its trusted Unit source. */
  readonly unitRevision?: number;
}

export interface ConfigurationTargetInput {
  readonly packageDefinitionId?: string;
  readonly variantId?: string;
}

export interface ConfigurationOptionAllowanceInput extends ConfigurationTargetInput {
  /** Every matching Product, Variant, and Package decision is conjunctive; true never overrides a false. */
  readonly allowed: boolean;
  readonly choiceKey: string;
  readonly evidenceRefs: readonly string[];
  readonly optionKey: string;
}

export interface ConfigurationMeasuredRuleInput extends ConfigurationTargetInput {
  /** Every matching range and step is conjunctive; target rules may narrow but never replace Product rules. */
  readonly choiceKey: string;
  readonly evidenceRefs: readonly string[];
  readonly maximum?: string;
  readonly maximumInclusive?: boolean;
  readonly minimum?: string;
  readonly minimumInclusive?: boolean;
  readonly step?: string;
  readonly stepBase?: string;
}

export interface ConfigurationCompatibilityRuleInput extends ConfigurationTargetInput {
  /** All matching compatibility rules apply; no row order or target precedence exists. */
  readonly choiceKey: string;
  readonly evidenceRefs: readonly string[];
  readonly kind: 'FORBIDDEN_PAIR' | 'CONDITIONAL_MAXIMUM';
  readonly maximum?: string;
  readonly maximumInclusive?: boolean;
  readonly optionKey: string;
  readonly otherChoiceKey: string;
  readonly otherOptionKey?: string;
  readonly ruleId: string;
}

export interface PublishProductConfigurationInput {
  readonly actionInvocationId: string;
  readonly choices: readonly ConfigurationChoiceInput[];
  readonly compatibilityRules: readonly ConfigurationCompatibilityRuleInput[];
  /** Stable Product-level identity. The first publication creates it at expectedRevision 0. */
  readonly definitionId: string;
  readonly effectiveFrom: Date;
  readonly evidenceRefs: readonly string[];
  readonly expectedRevision: number;
  readonly measuredRules: readonly ConfigurationMeasuredRuleInput[];
  readonly optionAllowances: readonly ConfigurationOptionAllowanceInput[];
  readonly principalId: string;
  readonly productId: string;
  readonly reason: string;
}

const PublishProductConfigurationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('published', { revision: Schema.Int }),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
  Schema.TaggedStruct('incompatible', { reason: Schema.String }),
]);
type PublishProductConfigurationOutcome = typeof PublishProductConfigurationOutcomeSchema.Type;

export interface CurrentConfigurationRevision {
  readonly choices: readonly ConfigurationChoiceInput[];
  readonly compatibilityRules: readonly ConfigurationCompatibilityRuleInput[];
  /** The owner-recorded publication evidence for the exact choice/option meanings. */
  readonly definitionEvidenceRefs: readonly string[];
  readonly definitionId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly measuredRules: readonly ConfigurationMeasuredRuleInput[];
  readonly optionAllowances: readonly ConfigurationOptionAllowanceInput[];
  readonly productId: string;
  readonly revision: number;
  readonly ruleCombination: 'CONJUNCTION_ONLY';
  readonly units: readonly ConfigurationUnitRevision[];
}

export interface ProductConfigurationPersistence {
  readonly publish: (
    input: PublishProductConfigurationInput,
  ) => Effect.Effect<PublishProductConfigurationOutcome, ProductConfigurationPersistenceUnavailable>;
  /** None means authoritatively no applicable revision; corrupt or ambiguous evidence is unavailable. */
  readonly readCurrent: (input: {
    readonly at: Date;
    readonly definitionId: string;
    readonly productId: string;
  }) => Effect.Effect<Option.Option<CurrentConfigurationRevision>, ProductConfigurationPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): ProductConfigurationPersistenceUnavailable => {
  const failure = new ProductConfigurationPersistenceUnavailable({
    code: 'product_configuration_persistence_unavailable',
    reason: 'Authoritative Product Configuration revision or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const text = (value: string, max = 1000): boolean => value.length > 0 && value.length <= max && value === value.trim();
const evidence = (values: readonly string[]): boolean => values.length > 0 && values.every((value) => text(value, 300));
const decimal = (value: string | undefined): boolean =>
  value === undefined || (value.length <= 1000 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value));
const decimalParts = (value: string) => {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { amount: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n), scale: fraction.length };
};
const compareDecimal = (left: string, right: string): number => {
  const first = decimalParts(left);
  const second = decimalParts(right);
  const leftScaled = first.amount * 10n ** BigInt(second.scale);
  const rightScaled = second.amount * 10n ** BigInt(first.scale);
  if (leftScaled < rightScaled) {
    return -1;
  }
  if (leftScaled > rightScaled) {
    return 1;
  }
  return 0;
};
const epoch = (value: Date): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const effectiveTimeFollows = (candidate: Date, previous: Date): boolean => epoch(candidate) > epoch(previous);

const validActivationTimeline = (
  definition: typeof productConfigurationDefinitions.$inferSelect,
  ordered: readonly (typeof productConfigurationRevisionActivations.$inferSelect)[],
): boolean =>
  Number.isSafeInteger(definition.currentRevision) &&
  definition.currentRevision >= 1 &&
  ordered.length === definition.currentRevision &&
  !ordered.some((activation, index) => {
    const predecessor = ordered[index - 1];
    return (
      activation.revision !== index + 1 ||
      activation.supersededRevision !== (index === 0 ? null : index) ||
      !Number.isFinite(epoch(activation.effectiveAt)) ||
      (predecessor !== undefined && !effectiveTimeFollows(activation.effectiveAt, predecessor.effectiveAt))
    );
  });
const targetKey = (value: ConfigurationTargetInput): string =>
  `${value.variantId ?? ''}|${value.packageDefinitionId ?? ''}`;
const validTarget = (value: ConfigurationTargetInput): boolean =>
  value.packageDefinitionId === undefined || value.variantId !== undefined;
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const overlappingTargets = (left: ConfigurationTargetInput, right: ConfigurationTargetInput): boolean =>
  (left.variantId === undefined || right.variantId === undefined || left.variantId === right.variantId) &&
  (left.packageDefinitionId === undefined ||
    right.packageDefinitionId === undefined ||
    left.packageDefinitionId === right.packageDefinitionId);
const conflictingBounds = (rules: readonly ConfigurationMeasuredRuleInput[]): boolean => {
  for (const lower of rules) {
    if (lower.minimum === undefined) {
      continue;
    }
    for (const upper of rules) {
      if (upper.maximum === undefined || !overlappingTargets(lower, upper)) {
        continue;
      }
      const order = compareDecimal(lower.minimum, upper.maximum);
      if (order > 0 || (order === 0 && (lower.minimumInclusive !== true || upper.maximumInclusive !== true))) {
        return true;
      }
    }
  }
  return false;
};
const modulo = (value: bigint, modulus: bigint): bigint => ((value % modulus) + modulus) % modulus;
const gcd = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
};
const inverse = (value: bigint, modulus: bigint): bigint => {
  let [remainder, next] = [modulus, modulo(value, modulus)];
  let [coefficient, nextCoefficient] = [0n, 1n];
  while (next !== 0n) {
    const quotient = remainder / next;
    [remainder, next] = [next, remainder - quotient * next];
    [coefficient, nextCoefficient] = [nextCoefficient, coefficient - quotient * nextCoefficient];
  }
  return modulo(coefficient, modulus);
};
const scaledDecimal = (value: string, scale: number): bigint => {
  const parts = decimalParts(value);
  return parts.amount * 10n ** BigInt(scale - parts.scale);
};
const satisfiableMeasuredSet = (rules: readonly ConfigurationMeasuredRuleInput[]): boolean => {
  const decimals = rules.flatMap((rule) => [rule.minimum, rule.maximum, rule.step, rule.stepBase]);
  const scale = Math.max(0, ...decimals.flatMap((value) => (value === undefined ? [] : [decimalParts(value).scale])));
  let minimum: bigint | undefined;
  let maximum: bigint | undefined;
  let residue = 0n;
  let period = 1n;
  for (const rule of rules) {
    if (rule.minimum !== undefined) {
      const bound = scaledDecimal(rule.minimum, scale) + (rule.minimumInclusive === true ? 0n : 1n);
      minimum = minimum === undefined || bound > minimum ? bound : minimum;
    }
    if (rule.maximum !== undefined) {
      const bound = scaledDecimal(rule.maximum, scale) - (rule.maximumInclusive === true ? 0n : 1n);
      maximum = maximum === undefined || bound < maximum ? bound : maximum;
    }
    if (rule.step !== undefined && rule.stepBase !== undefined) {
      const step = scaledDecimal(rule.step, scale);
      const base = scaledDecimal(rule.stepBase, scale);
      const divisor = gcd(period, step);
      const difference = base - residue;
      if (difference % divisor !== 0n) {
        return false;
      }
      const reduced = step / divisor;
      const offset = modulo((difference / divisor) * inverse(period / divisor, reduced), reduced);
      residue = modulo(residue + period * offset, period * reduced);
      period *= reduced;
    }
  }
  if (minimum === undefined || maximum === undefined) {
    return true;
  }
  return minimum + modulo(residue - minimum, period) <= maximum;
};
const conflictingLayeredConstraints = (rules: readonly ConfigurationMeasuredRuleInput[]): boolean => {
  const targets: readonly ConfigurationTargetInput[] = [{}, ...rules];
  return targets.some(
    (target) =>
      !satisfiableMeasuredSet(
        rules.filter(
          (rule) =>
            (rule.variantId === undefined || rule.variantId === target.variantId) &&
            (rule.packageDefinitionId === undefined || rule.packageDefinitionId === target.packageDefinitionId),
        ),
      ),
  );
};
const invalidMeasuredBounds = (rule: ConfigurationMeasuredRuleInput): boolean =>
  !decimal(rule.minimum) ||
  !decimal(rule.maximum) ||
  !decimal(rule.step) ||
  !decimal(rule.stepBase) ||
  (rule.minimum === undefined) !== (rule.minimumInclusive === undefined) ||
  (rule.maximum === undefined) !== (rule.maximumInclusive === undefined) ||
  (rule.step === undefined) !== (rule.stepBase === undefined) ||
  (rule.step !== undefined && compareDecimal(rule.step, '0') <= 0) ||
  (rule.minimum !== undefined &&
    rule.maximum !== undefined &&
    (compareDecimal(rule.minimum, rule.maximum) > 0 ||
      (compareDecimal(rule.minimum, rule.maximum) === 0 &&
        (rule.minimumInclusive !== true || rule.maximumInclusive !== true))));

const inspectChoice = (choice: ConfigurationChoiceInput): string | null => {
  if (!text(choice.choiceKey, 160) || !text(choice.meaning) || !text(choice.label, 240)) {
    return 'Choice identity and meaning are required';
  }
  if (choice.kind === 'MEASURED_VALUE') {
    return text(choice.unitId ?? '') && (choice.options === undefined || choice.options.length === 0)
      ? null
      : 'Measured Value requires a Unit and no options';
  }
  if (
    choice.unitId !== undefined ||
    choice.options === undefined ||
    choice.options.length === 0 ||
    !unique(choice.options.map((option) => option.optionKey))
  ) {
    return 'Single Choice requires distinct explicit options and no Unit';
  }
  return choice.options.some(
    (option) => !text(option.optionKey, 160) || !text(option.meaning) || !text(option.label, 240),
  )
    ? 'Option identity and meaning are required'
    : null;
};

const knownOption = (
  choices: ReadonlyMap<string, ConfigurationChoiceInput>,
  choiceKey: string,
  optionKey: string,
): boolean => choices.get(choiceKey)?.options?.some((option) => option.optionKey === optionKey) ?? false;

const inspectAllowances = (
  input: Pick<PublishProductConfigurationInput, 'choices' | 'optionAllowances'>,
  choices: ReadonlyMap<string, ConfigurationChoiceInput>,
): string | null => {
  if (!unique(input.optionAllowances.map((rule) => `${rule.choiceKey}|${rule.optionKey}|${targetKey(rule)}`))) {
    return 'Duplicate option allowance';
  }
  if (
    input.optionAllowances.some(
      (rule) =>
        !validTarget(rule) || !knownOption(choices, rule.choiceKey, rule.optionKey) || !evidence(rule.evidenceRefs),
    )
  ) {
    return 'Option allowance lacks a valid target, option, or evidence';
  }
  return input.choices.some(
    (choice) =>
      choice.kind === 'SINGLE_CHOICE' &&
      choice.options?.some(
        (option) =>
          !input.optionAllowances.some(
            (rule) =>
              rule.choiceKey === choice.choiceKey &&
              rule.optionKey === option.optionKey &&
              rule.variantId === undefined &&
              rule.packageDefinitionId === undefined,
          ),
      ) === true,
  )
    ? 'Every option needs an explicit Product-level allowance decision'
    : null;
};

const inspectMeasured = (
  input: Pick<PublishProductConfigurationInput, 'choices' | 'measuredRules'>,
  choices: ReadonlyMap<string, ConfigurationChoiceInput>,
): string | null => {
  if (!unique(input.measuredRules.map((rule) => `${rule.choiceKey}|${targetKey(rule)}`))) {
    return 'Duplicate measured rule';
  }
  for (const rule of input.measuredRules) {
    if (
      !validTarget(rule) ||
      choices.get(rule.choiceKey)?.kind !== 'MEASURED_VALUE' ||
      !evidence(rule.evidenceRefs) ||
      invalidMeasuredBounds(rule)
    ) {
      return 'Measured rule bounds or step are invalid';
    }
  }
  for (const choice of input.choices) {
    if (
      choice.kind === 'MEASURED_VALUE' &&
      (conflictingBounds(input.measuredRules.filter((rule) => rule.choiceKey === choice.choiceKey)) ||
        conflictingLayeredConstraints(input.measuredRules.filter((rule) => rule.choiceKey === choice.choiceKey)))
    ) {
      return 'Combined measured rule bounds are contradictory';
    }
  }
  return input.choices.some(
    (choice) =>
      choice.kind === 'MEASURED_VALUE' &&
      !input.measuredRules.some(
        (rule) =>
          rule.choiceKey === choice.choiceKey && rule.variantId === undefined && rule.packageDefinitionId === undefined,
      ),
  )
    ? 'Every Measured Value needs an explicit Product-level rule'
    : null;
};

const impossibleForbiddenPair = (rule: ConfigurationCompatibilityRuleInput): boolean =>
  rule.choiceKey === rule.otherChoiceKey && rule.optionKey !== rule.otherOptionKey;

const inspectCompatibility = (
  input: Pick<PublishProductConfigurationInput, 'compatibilityRules'>,
  choices: ReadonlyMap<string, ConfigurationChoiceInput>,
): string | null => {
  if (!unique(input.compatibilityRules.map((rule) => rule.ruleId))) {
    return 'Duplicate compatibility rule identity';
  }
  for (const rule of input.compatibilityRules) {
    if (
      !text(rule.ruleId) ||
      !validTarget(rule) ||
      !evidence(rule.evidenceRefs) ||
      !knownOption(choices, rule.choiceKey, rule.optionKey) ||
      (rule.kind === 'FORBIDDEN_PAIR' &&
        (!knownOption(choices, rule.otherChoiceKey, rule.otherOptionKey ?? '') ||
          impossibleForbiddenPair(rule) ||
          rule.maximum !== undefined ||
          rule.maximumInclusive !== undefined)) ||
      (rule.kind === 'CONDITIONAL_MAXIMUM' &&
        (choices.get(rule.otherChoiceKey)?.kind !== 'MEASURED_VALUE' ||
          rule.otherOptionKey !== undefined ||
          !decimal(rule.maximum) ||
          rule.maximum === undefined ||
          rule.maximumInclusive === undefined))
    ) {
      return 'Compatibility operands or evidence are invalid';
    }
  }
  return null;
};

const inspectProductConfigurationRules = (input: ConfigurationRuleSnapshot): string | null => {
  if (input.choices.length === 0 || !unique(input.choices.map((choice) => choice.choiceKey))) {
    return 'Choices must be explicit and unique';
  }
  for (const choice of input.choices) {
    const issue = inspectChoice(choice);
    if (issue !== null) {
      return issue;
    }
  }
  const choices = new Map(input.choices.map((choice) => [choice.choiceKey, choice]));
  return inspectAllowances(input, choices) ?? inspectMeasured(input, choices) ?? inspectCompatibility(input, choices);
};

/** Detect malformed constraints without treating a missing decision as a customer-value violation. */
export const inspectProductConfigurationRuleConsistency = (
  input: Pick<PublishProductConfigurationInput, 'choices' | 'measuredRules' | 'compatibilityRules'>,
): string | null => {
  const choices = new Map(input.choices.map((choice) => [choice.choiceKey, choice]));
  return inspectMeasured(input, choices) ?? inspectCompatibility(input, choices);
};

export const inspectProductConfigurationPublishInput = (input: PublishProductConfigurationInput): string | null => {
  if (
    !text(input.actionInvocationId) ||
    !text(input.principalId) ||
    !text(input.productId) ||
    !text(input.definitionId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    Option.isNone(DateTime.make(input.effectiveFrom)) ||
    !text(input.reason) ||
    !evidence(input.evidenceRefs)
  ) {
    return 'Invalid scope, revision, effectiveness, or action evidence';
  }
  return inspectProductConfigurationRules(input);
};
const inspectActingPrincipal = (input: PublishProductConfigurationInput, trustedPrincipalId: string): string | null =>
  input.principalId === trustedPrincipalId ? null : 'Acting Principal does not match trusted operation scope';
const inspectPublishInput = (input: PublishProductConfigurationInput, principalId: string) =>
  inspectProductConfigurationPublishInput(input) ?? inspectActingPrincipal(input, principalId);
const activeProduct = (product: typeof products.$inferSelect | undefined): boolean =>
  product !== undefined && product.lifecycleState === 'ACTIVE';

const persistChoice = Effect.fn('ProductConfigurationPersistence.persistChoice')(function* persistChoice(
  transaction: ScopedTransaction,
  tenantId: string,
  definitionId: string,
  revision: number,
  choice: ConfigurationChoiceInput,
  unitRevision: number | undefined,
) {
  yield* transaction.insert(productConfigurationChoices).values({
    choiceKey: choice.choiceKey,
    definitionId,
    label: choice.label,
    meaning: choice.meaning,
    required: choice.required,
    revision,
    tenantId,
    unitId: choice.unitId ?? null,
    unitRevision: unitRevision ?? null,
    valueKind: choice.kind,
  });
  if (choice.options !== undefined && choice.options.length > 0) {
    yield* transaction.insert(productConfigurationChoiceOptions).values(
      choice.options.map((option) => ({
        choiceKey: choice.choiceKey,
        definitionId,
        revision,
        tenantId,
        ...option,
      })),
    );
  }
}, Effect.mapError(unavailable));

const sameRecordedInvocation = (
  prior: typeof productConfigurationDefinitionRevisions.$inferSelect,
  input: PublishProductConfigurationInput,
): boolean =>
  prior.definitionId === input.definitionId &&
  prior.productId === input.productId &&
  prior.revision === input.expectedRevision + 1 &&
  epoch(prior.effectiveFrom) === epoch(input.effectiveFrom) &&
  prior.reason === input.reason &&
  prior.actingPrincipalId === input.principalId &&
  prior.evidenceRefs.length === input.evidenceRefs.length &&
  prior.evidenceRefs.every((ref, index) => ref === input.evidenceRefs[index]);

const comparableSnapshot = (
  value: Pick<
    PublishProductConfigurationInput,
    'choices' | 'optionAllowances' | 'measuredRules' | 'compatibilityRules'
  >,
) => ({
  choices: value.choices
    .map((choice) => ({
      choiceKey: choice.choiceKey,
      kind: choice.kind,
      label: choice.label,
      meaning: choice.meaning,
      options: (choice.options ?? [])
        .map((option) => ({ label: option.label, meaning: option.meaning, optionKey: option.optionKey }))
        .toSorted((a, b) => a.optionKey.localeCompare(b.optionKey)),
      required: choice.required,
      unitId: choice.unitId ?? null,
    }))
    .toSorted((a, b) => a.choiceKey.localeCompare(b.choiceKey)),
  compatibilityRules: value.compatibilityRules
    .map((rule) => ({
      choiceKey: rule.choiceKey,
      evidenceRefs: rule.evidenceRefs,
      kind: rule.kind,
      maximum: rule.maximum ?? null,
      maximumInclusive: rule.maximumInclusive ?? null,
      optionKey: rule.optionKey,
      otherChoiceKey: rule.otherChoiceKey,
      otherOptionKey: rule.otherOptionKey ?? null,
      packageDefinitionId: rule.packageDefinitionId ?? null,
      ruleId: rule.ruleId,
      variantId: rule.variantId ?? null,
    }))
    .toSorted((a, b) => a.ruleId.localeCompare(b.ruleId)),
  measuredRules: value.measuredRules
    .map((rule) => ({
      choiceKey: rule.choiceKey,
      evidenceRefs: rule.evidenceRefs,
      maximum: rule.maximum ?? null,
      maximumInclusive: rule.maximumInclusive ?? null,
      minimum: rule.minimum ?? null,
      minimumInclusive: rule.minimumInclusive ?? null,
      packageDefinitionId: rule.packageDefinitionId ?? null,
      step: rule.step ?? null,
      stepBase: rule.stepBase ?? null,
      variantId: rule.variantId ?? null,
    }))
    .toSorted((a, b) =>
      `${a.choiceKey}|${a.variantId ?? ''}|${a.packageDefinitionId ?? ''}`.localeCompare(
        `${b.choiceKey}|${b.variantId ?? ''}|${b.packageDefinitionId ?? ''}`,
      ),
    ),
  optionAllowances: value.optionAllowances
    .map((rule) => ({
      allowed: rule.allowed,
      choiceKey: rule.choiceKey,
      evidenceRefs: rule.evidenceRefs,
      optionKey: rule.optionKey,
      packageDefinitionId: rule.packageDefinitionId ?? null,
      variantId: rule.variantId ?? null,
    }))
    .toSorted((a, b) =>
      `${a.choiceKey}|${a.optionKey}|${a.variantId ?? ''}|${a.packageDefinitionId ?? ''}`.localeCompare(
        `${b.choiceKey}|${b.optionKey}|${b.variantId ?? ''}|${b.packageDefinitionId ?? ''}`,
      ),
    ),
});

const sameRecordedSnapshot = (
  input: PublishProductConfigurationInput,
  recorded: CurrentConfigurationRevision,
): boolean => isDeepStrictEqual(comparableSnapshot(input), comparableSnapshot(recorded));

const inspectDefinitionVersion = (
  definition: typeof productConfigurationDefinitions.$inferSelect | undefined,
  input: PublishProductConfigurationInput,
): PublishProductConfigurationOutcome | null => {
  if (definition === undefined && input.expectedRevision !== 0) {
    return { _tag: 'not_found' };
  }
  if (definition !== undefined && definition.currentRevision !== input.expectedRevision) {
    return { _tag: 'stale', actualRevision: definition.currentRevision };
  }
  if (definition !== undefined && definition.productId !== input.productId) {
    return { _tag: 'invalid', reason: 'Definition belongs to a different Product' };
  }
  return null;
};

const publishUnitRevisions = Effect.fn('ProductConfigurationPersistence.publishUnitRevisions')(
  function* publishUnitRevisions(
    choices: readonly ConfigurationChoiceInput[],
    effectiveFrom: Date,
    unitSource: Pick<ConfigurationUnitPersistence, 'readCurrent'>,
  ) {
    const measured = choices.filter((choice) => choice.kind === 'MEASURED_VALUE' && choice.unitId !== undefined);
    const current = yield* Effect.forEach(
      measured,
      (choice) => unitSource.readCurrent(choice.unitId ?? '', effectiveFrom).pipe(Effect.mapError(unavailable)),
      { concurrency: 1 },
    );
    if (current.some((unit) => unit.status !== 'CONFIRMED')) {
      return yield* unavailable();
    }
    return new Map(
      measured.flatMap((choice, index) => {
        const unit = current[index];
        return unit?.status === 'CONFIRMED' ? [[choice.choiceKey, unit.revision.revision] as const] : [];
      }),
    );
  },
);

const readPinnedUnits = Effect.fn('ProductConfigurationPersistence.readPinnedUnits')(function* readPinnedUnits(
  choices: readonly (typeof productConfigurationChoices.$inferSelect)[],
  at: Date,
  unitSource: Pick<ConfigurationUnitPersistence, 'readCurrent'>,
) {
  const measured = choices.filter((choice) => choice.valueKind === 'MEASURED_VALUE');
  if (measured.some((choice) => choice.unitId === null || choice.unitRevision === null)) {
    return yield* unavailable();
  }
  const current = yield* Effect.forEach(
    measured,
    (choice) => unitSource.readCurrent(choice.unitId ?? '', at).pipe(Effect.mapError(unavailable)),
    { concurrency: 1 },
  );
  if (
    current.some(
      (unit, index) => unit.status !== 'CONFIRMED' || unit.revision.revision !== measured[index]?.unitRevision,
    )
  ) {
    return yield* unavailable();
  }
  return current.flatMap((unit) => (unit.status === 'CONFIRMED' ? [unit.revision] : []));
});

/** Core owns the scoped transaction and its rollback; no private row escapes another Tenant. */
export const productConfigurationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  selectionImpact?: ConfigurationSelectionImpact,
  unitSource: Pick<ConfigurationUnitPersistence, 'readCurrent'> = configurationUnitPersistenceForScope(
    transaction,
    scope,
  ),
): ProductConfigurationPersistence => {
  const { tenantId } = scope;
  let readCurrent: ProductConfigurationPersistence['readCurrent'] = (_input) => Effect.fail(unavailable());
  const publish: ProductConfigurationPersistence['publish'] = Effect.fn('ProductConfigurationPersistence.publish')(
    function* publish(input) {
      const invalid = inspectPublishInput(input, scope.principalId);
      if (invalid !== null) {
        return { _tag: 'invalid', reason: invalid };
      }
      const [prior] = yield* transaction
        .select()
        .from(productConfigurationDefinitionRevisions)
        .where(
          and(
            eq(productConfigurationDefinitionRevisions.tenantId, tenantId),
            eq(productConfigurationDefinitionRevisions.actionInvocationId, input.actionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (prior !== undefined) {
        if (!sameRecordedInvocation(prior, input)) {
          return { _tag: 'invalid', reason: 'Action invocation already records different Configuration evidence' };
        }
        const previous = yield* readCurrent({
          at: prior.effectiveFrom,
          definitionId: prior.definitionId,
          productId: prior.productId,
        });
        if (Option.isNone(previous)) {
          return yield* unavailable();
        }
        if (!sameRecordedSnapshot(input, previous.value)) {
          return {
            _tag: 'invalid',
            reason: 'Action invocation already records a different Configuration rule snapshot',
          };
        }
        return { _tag: 'published', revision: prior.revision };
      }
      // Lock the Product before probing a possibly absent Definition, serializing first publications.
      const [product] = yield* transaction
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, input.productId)))
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (!activeProduct(product)) {
        return { _tag: 'invalid', reason: 'Product is not Current and active' };
      }
      const [definition] = yield* transaction
        .select()
        .from(productConfigurationDefinitions)
        .where(
          and(
            eq(productConfigurationDefinitions.tenantId, tenantId),
            eq(productConfigurationDefinitions.definitionId, input.definitionId),
          ),
        )
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      const versionIssue = inspectDefinitionVersion(definition, input);
      if (versionIssue !== null) {
        return versionIssue;
      }
      const [last] =
        definition === undefined
          ? [undefined]
          : yield* transaction
              .select()
              .from(productConfigurationRevisionActivations)
              .where(
                and(
                  eq(productConfigurationRevisionActivations.tenantId, tenantId),
                  eq(productConfigurationRevisionActivations.definitionId, input.definitionId),
                  eq(productConfigurationRevisionActivations.revision, definition.currentRevision),
                ),
              )
              .for('update')
              .limit(1)
              .pipe(Effect.mapError(unavailable));
      if (definition !== undefined && last === undefined) {
        return yield* unavailable();
      }
      if (last !== undefined) {
        // A new publication must not extend a timeline whose prior evidence is incomplete.
        yield* readCurrent({ at: last.effectiveAt, definitionId: input.definitionId, productId: input.productId });
      }
      if (last !== undefined && !effectiveTimeFollows(input.effectiveFrom, last.effectiveAt)) {
        return { _tag: 'invalid', reason: 'Effective time must follow the preceding activation' };
      }
      const revision = input.expectedRevision + 1;
      const unitRevisions = yield* publishUnitRevisions(input.choices, input.effectiveFrom, unitSource);
      if (selectionImpact === undefined) {
        return yield* unavailable();
      }
      const compatible = yield* selectionImpact.verify({
        definitionId: input.definitionId,
        effectiveFrom: input.effectiveFrom,
        previousRevision: input.expectedRevision,
        productId: input.productId,
        proposed: {
          choices: input.choices,
          compatibilityRules: input.compatibilityRules,
          measuredRules: input.measuredRules,
          optionAllowances: input.optionAllowances,
        },
        proposedRevision: revision,
        tenantId,
      });
      if (!compatible) {
        return { _tag: 'incompatible', reason: 'Open-selection impact or first-publication absence is not proven' };
      }
      if (definition === undefined) {
        yield* transaction
          .insert(productConfigurationDefinitions)
          .values({ currentRevision: revision, definitionId: input.definitionId, productId: input.productId, tenantId })
          .pipe(Effect.mapError(unavailable));
      } else {
        const [updated] = yield* transaction
          .update(productConfigurationDefinitions)
          .set({ currentRevision: revision })
          .where(
            and(
              eq(productConfigurationDefinitions.tenantId, tenantId),
              eq(productConfigurationDefinitions.definitionId, input.definitionId),
              eq(productConfigurationDefinitions.currentRevision, input.expectedRevision),
            ),
          )
          .returning()
          .pipe(Effect.mapError(unavailable));
        if (updated === undefined) {
          return { _tag: 'stale', actualRevision: definition.currentRevision };
        }
      }
      yield* transaction
        .insert(productConfigurationDefinitionRevisions)
        .values({
          actingPrincipalId: scope.principalId,
          actionInvocationId: input.actionInvocationId,
          definitionId: input.definitionId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          evidenceRefs: [...input.evidenceRefs],
          productId: input.productId,
          reason: input.reason,
          revision,
          state: 'ACTIVE',
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));
      yield* transaction
        .insert(productConfigurationRevisionActivations)
        .values({
          actingPrincipalId: scope.principalId,
          actionInvocationId: input.actionInvocationId,
          definitionId: input.definitionId,
          effectiveAt: input.effectiveFrom,
          evidenceRefs: [...input.evidenceRefs],
          reason: input.reason,
          revision,
          supersededRevision: last?.revision ?? null,
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));
      yield* Effect.forEach(
        input.choices,
        (choice) =>
          persistChoice(
            transaction,
            tenantId,
            input.definitionId,
            revision,
            choice,
            unitRevisions.get(choice.choiceKey),
          ),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        input.optionAllowances,
        (rule) =>
          transaction
            .insert(productConfigurationOptionAllowances)
            .values({
              allowed: rule.allowed,
              choiceKey: rule.choiceKey,
              definitionId: input.definitionId,
              evidenceRefs: [...rule.evidenceRefs],
              optionKey: rule.optionKey,
              packageDefinitionId: rule.packageDefinitionId ?? null,
              productId: input.productId,
              revision,
              tenantId,
              variantId: rule.variantId ?? null,
            })
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        input.measuredRules,
        (rule) =>
          transaction
            .insert(productConfigurationMeasuredRules)
            .values({
              choiceKey: rule.choiceKey,
              definitionId: input.definitionId,
              evidenceRefs: [...rule.evidenceRefs],
              maximum: rule.maximum ?? null,
              maximumInclusive: rule.maximumInclusive ?? null,
              minimum: rule.minimum ?? null,
              minimumInclusive: rule.minimumInclusive ?? null,
              packageDefinitionId: rule.packageDefinitionId ?? null,
              productId: input.productId,
              revision,
              step: rule.step ?? null,
              stepBase: rule.stepBase ?? null,
              tenantId,
              variantId: rule.variantId ?? null,
            })
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        input.compatibilityRules,
        (rule) =>
          transaction
            .insert(productConfigurationCompatibilityRules)
            .values({
              choiceKey: rule.choiceKey,
              definitionId: input.definitionId,
              evidenceRefs: [...rule.evidenceRefs],
              kind: rule.kind,
              maximum: rule.maximum ?? null,
              maximumInclusive: rule.maximumInclusive ?? null,
              optionKey: rule.optionKey,
              otherChoiceKey: rule.otherChoiceKey,
              otherOptionKey: rule.otherOptionKey ?? null,
              packageDefinitionId: rule.packageDefinitionId ?? null,
              productId: input.productId,
              revision,
              ruleId: rule.ruleId,
              tenantId,
              variantId: rule.variantId ?? null,
            })
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
      return { _tag: 'published', revision };
    },
  );

  readCurrent = Effect.fn('ProductConfigurationPersistence.readCurrent')(function* readCurrentStep(input) {
    if (Option.isNone(DateTime.make(input.at))) {
      return yield* unavailable();
    }
    const [definition] = yield* transaction
      .select()
      .from(productConfigurationDefinitions)
      .where(
        and(
          eq(productConfigurationDefinitions.tenantId, tenantId),
          eq(productConfigurationDefinitions.productId, input.productId),
          eq(productConfigurationDefinitions.definitionId, input.definitionId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return Option.none();
    }
    const activations = yield* transaction
      .select()
      .from(productConfigurationRevisionActivations)
      .where(
        and(
          eq(productConfigurationRevisionActivations.tenantId, tenantId),
          eq(productConfigurationRevisionActivations.definitionId, input.definitionId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const ordered = [...activations].toSorted((a, b) => epoch(a.effectiveAt) - epoch(b.effectiveAt));
    if (!validActivationTimeline(definition, ordered)) {
      return yield* unavailable();
    }
    const revisions = yield* transaction
      .select()
      .from(productConfigurationDefinitionRevisions)
      .where(
        and(
          eq(productConfigurationDefinitionRevisions.tenantId, tenantId),
          eq(productConfigurationDefinitionRevisions.definitionId, input.definitionId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (
      revisions.length !== ordered.length ||
      ordered.some((activation) => {
        const revision = revisions.find((candidate) => candidate.revision === activation.revision);
        return (
          revision === undefined ||
          revision.productId !== input.productId ||
          revision.state !== 'ACTIVE' ||
          epoch(revision.effectiveFrom) !== epoch(activation.effectiveAt) ||
          revision.actionInvocationId !== activation.actionInvocationId ||
          revision.actingPrincipalId !== activation.actingPrincipalId ||
          revision.reason !== activation.reason ||
          !isDeepStrictEqual(revision.evidenceRefs, activation.evidenceRefs)
        );
      })
    ) {
      return yield* unavailable();
    }
    const activeIndex = ordered.findLastIndex((activation) => epoch(activation.effectiveAt) <= epoch(input.at));
    if (activeIndex === -1) {
      return Option.none();
    }
    const activation = ordered[activeIndex];
    if (activation === undefined) {
      return yield* unavailable();
    }
    const [revision] = yield* transaction
      .select()
      .from(productConfigurationDefinitionRevisions)
      .where(
        and(
          eq(productConfigurationDefinitionRevisions.tenantId, tenantId),
          eq(productConfigurationDefinitionRevisions.definitionId, input.definitionId),
          eq(productConfigurationDefinitionRevisions.revision, activation.revision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      revision === undefined ||
      revision.productId !== input.productId ||
      revision.state !== 'ACTIVE' ||
      epoch(revision.effectiveFrom) !== epoch(activation.effectiveAt) ||
      revision.actionInvocationId !== activation.actionInvocationId ||
      revision.actingPrincipalId !== activation.actingPrincipalId ||
      revision.reason !== activation.reason ||
      !isDeepStrictEqual(revision.evidenceRefs, activation.evidenceRefs)
    ) {
      return yield* unavailable();
    }
    const [choiceRows, optionRows, allowanceRows, measuredRows, compatibilityRows] = yield* Effect.all(
      [
        transaction
          .select()
          .from(productConfigurationChoices)
          .where(
            and(
              eq(productConfigurationChoices.tenantId, tenantId),
              eq(productConfigurationChoices.definitionId, input.definitionId),
              eq(productConfigurationChoices.revision, activation.revision),
            ),
          ),
        transaction
          .select()
          .from(productConfigurationChoiceOptions)
          .where(
            and(
              eq(productConfigurationChoiceOptions.tenantId, tenantId),
              eq(productConfigurationChoiceOptions.definitionId, input.definitionId),
              eq(productConfigurationChoiceOptions.revision, activation.revision),
            ),
          ),
        transaction
          .select()
          .from(productConfigurationOptionAllowances)
          .where(
            and(
              eq(productConfigurationOptionAllowances.tenantId, tenantId),
              eq(productConfigurationOptionAllowances.definitionId, input.definitionId),
              eq(productConfigurationOptionAllowances.revision, activation.revision),
            ),
          ),
        transaction
          .select()
          .from(productConfigurationMeasuredRules)
          .where(
            and(
              eq(productConfigurationMeasuredRules.tenantId, tenantId),
              eq(productConfigurationMeasuredRules.definitionId, input.definitionId),
              eq(productConfigurationMeasuredRules.revision, activation.revision),
            ),
          ),
        transaction
          .select()
          .from(productConfigurationCompatibilityRules)
          .where(
            and(
              eq(productConfigurationCompatibilityRules.tenantId, tenantId),
              eq(productConfigurationCompatibilityRules.definitionId, input.definitionId),
              eq(productConfigurationCompatibilityRules.revision, activation.revision),
            ),
          ),
      ] as const,
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    if (compatibilityRows.some((rule) => rule.kind !== 'FORBIDDEN_PAIR' && rule.kind !== 'CONDITIONAL_MAXIMUM')) {
      return yield* unavailable();
    }
    const units: ConfigurationUnitRevision[] = yield* readPinnedUnits(choiceRows, input.at, unitSource);
    const choices: ConfigurationChoiceInput[] = choiceRows.map((choice) => {
      const base = {
        choiceKey: choice.choiceKey,
        label: choice.label,
        meaning: choice.meaning,
        required: choice.required,
      };
      if (choice.valueKind === 'SINGLE_CHOICE' && choice.unitId === null) {
        const options = optionRows.flatMap((option) =>
          option.choiceKey === choice.choiceKey
            ? [{ label: option.label, meaning: option.meaning, optionKey: option.optionKey }]
            : [],
        );
        return { ...base, kind: 'SINGLE_CHOICE', options };
      }
      if (choice.valueKind === 'MEASURED_VALUE' && choice.unitId !== null) {
        const measured: ConfigurationChoiceInput = { ...base, kind: 'MEASURED_VALUE', unitId: choice.unitId };
        if (choice.unitRevision !== null) {
          Object.assign(measured, { unitRevision: choice.unitRevision });
        }
        return measured;
      }
      return { ...base, kind: 'SINGLE_CHOICE', options: [] };
    });
    const optionAllowances: ConfigurationOptionAllowanceInput[] = allowanceRows.map((rule) => {
      const value: ConfigurationOptionAllowanceInput = {
        allowed: rule.allowed,
        choiceKey: rule.choiceKey,
        evidenceRefs: rule.evidenceRefs,
        optionKey: rule.optionKey,
      };
      if (rule.variantId !== null) {
        Object.assign(value, { variantId: rule.variantId });
      }
      if (rule.packageDefinitionId !== null) {
        Object.assign(value, { packageDefinitionId: rule.packageDefinitionId });
      }
      return value;
    });
    const measuredRules: ConfigurationMeasuredRuleInput[] = measuredRows.map((rule) => {
      const value: ConfigurationMeasuredRuleInput = { choiceKey: rule.choiceKey, evidenceRefs: rule.evidenceRefs };
      if (rule.variantId !== null) {
        Object.assign(value, { variantId: rule.variantId });
      }
      if (rule.packageDefinitionId !== null) {
        Object.assign(value, { packageDefinitionId: rule.packageDefinitionId });
      }
      if (rule.minimum !== null && rule.minimumInclusive !== null) {
        Object.assign(value, { minimum: rule.minimum, minimumInclusive: rule.minimumInclusive });
      }
      if (rule.maximum !== null && rule.maximumInclusive !== null) {
        Object.assign(value, { maximum: rule.maximum, maximumInclusive: rule.maximumInclusive });
      }
      if (rule.step !== null && rule.stepBase !== null) {
        Object.assign(value, { step: rule.step, stepBase: rule.stepBase });
      }
      return value;
    });
    const compatibilityRules: ConfigurationCompatibilityRuleInput[] = compatibilityRows.map((rule) => {
      const value: ConfigurationCompatibilityRuleInput = {
        choiceKey: rule.choiceKey,
        evidenceRefs: rule.evidenceRefs,
        kind: rule.kind === 'FORBIDDEN_PAIR' ? 'FORBIDDEN_PAIR' : 'CONDITIONAL_MAXIMUM',
        optionKey: rule.optionKey,
        otherChoiceKey: rule.otherChoiceKey,
        ruleId: rule.ruleId,
      };
      if (rule.variantId !== null) {
        Object.assign(value, { variantId: rule.variantId });
      }
      if (rule.packageDefinitionId !== null) {
        Object.assign(value, { packageDefinitionId: rule.packageDefinitionId });
      }
      if (rule.otherOptionKey !== null) {
        Object.assign(value, { otherOptionKey: rule.otherOptionKey });
      }
      if (rule.maximum !== null && rule.maximumInclusive !== null) {
        Object.assign(value, { maximum: rule.maximum, maximumInclusive: rule.maximumInclusive });
      }
      return value;
    });
    if (
      inspectProductConfigurationPublishInput({
        actionInvocationId: revision.actionInvocationId,
        choices,
        compatibilityRules,
        definitionId: input.definitionId,
        effectiveFrom: activation.effectiveAt,
        evidenceRefs: revision.evidenceRefs,
        expectedRevision: activation.revision - 1,
        measuredRules,
        optionAllowances,
        principalId: revision.actingPrincipalId,
        productId: input.productId,
        reason: revision.reason,
      }) !== null
    ) {
      return yield* unavailable();
    }
    const nextActivation = ordered[activeIndex + 1];
    const current: CurrentConfigurationRevision = {
      choices,
      compatibilityRules,
      definitionEvidenceRefs: revision.evidenceRefs,
      definitionId: input.definitionId,
      effectiveFrom: activation.effectiveAt,
      measuredRules,
      optionAllowances,
      productId: input.productId,
      revision: activation.revision,
      ruleCombination: 'CONJUNCTION_ONLY',
      units,
    };
    if (nextActivation !== undefined) {
      Object.assign(current, { effectiveTo: nextActivation.effectiveAt });
    }
    return Option.some(current);
  });
  return { publish, readCurrent };
};
