import { Schema } from 'effect';

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ChoiceKey = Key.pipe(Schema.brand('CatalogConfigurationChoiceKey'));
const OptionKey = Key.pipe(Schema.brand('CatalogConfigurationOptionKey'));
const RuleId = Key.pipe(Schema.brand('CatalogConfigurationRuleId'));
const DefinitionId = Key.pipe(Schema.brand('CatalogConfigurationDefinitionId'));
const ProductId = Key.pipe(Schema.brand('CatalogConfigurationProductId'));
const VariantId = Key.pipe(Schema.brand('CatalogConfigurationVariantId'));
const PackageDefinitionId = Key.pipe(Schema.brand('CatalogConfigurationPackageDefinitionId'));
const UnitId = Key.pipe(Schema.brand('CatalogConfigurationUnitId'));
const Evidence = Schema.Array(Key);
const Target = {
  packageDefinitionId: Schema.optionalKey(PackageDefinitionId),
  variantId: Schema.optionalKey(VariantId),
};
const Choice = Schema.Struct({
  choiceKey: ChoiceKey,
  kind: Schema.Literals(['SINGLE_CHOICE', 'MEASURED_VALUE']),
  label: Key,
  meaning: Key,
  options: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Key, meaning: Key, optionKey: OptionKey }))),
  required: Schema.Boolean,
  unitId: Schema.optionalKey(UnitId),
});
const Allowance = Schema.Struct({
  ...Target,
  allowed: Schema.Boolean,
  choiceKey: ChoiceKey,
  evidenceRefs: Evidence,
  optionKey: OptionKey,
});
const Measured = Schema.Struct({
  ...Target,
  choiceKey: ChoiceKey,
  evidenceRefs: Evidence,
  maximum: Schema.optionalKey(Key),
  maximumInclusive: Schema.optionalKey(Schema.Boolean),
  minimum: Schema.optionalKey(Key),
  minimumInclusive: Schema.optionalKey(Schema.Boolean),
  step: Schema.optionalKey(Key),
  stepBase: Schema.optionalKey(Key),
});
const Compatibility = Schema.Struct({
  ...Target,
  choiceKey: ChoiceKey,
  evidenceRefs: Evidence,
  kind: Schema.Literals(['FORBIDDEN_PAIR', 'CONDITIONAL_MAXIMUM']),
  maximum: Schema.optionalKey(Key),
  maximumInclusive: Schema.optionalKey(Schema.Boolean),
  optionKey: OptionKey,
  otherChoiceKey: ChoiceKey,
  otherOptionKey: Schema.optionalKey(OptionKey),
  ruleId: RuleId,
});

export const PublishProductConfigurationPayloadSchema = Schema.Struct({
  choices: Schema.Array(Choice),
  compatibilityRules: Schema.Array(Compatibility),
  definitionId: DefinitionId,
  effectiveFrom: Schema.Date,
  evidenceRefs: Evidence,
  expectedRevision: Schema.Int,
  measuredRules: Schema.Array(Measured),
  optionAllowances: Schema.Array(Allowance),
  productId: ProductId,
  reason: Key,
});
export type PublishProductConfigurationPayload = typeof PublishProductConfigurationPayloadSchema.Type;
export const PublishProductConfigurationResultSchema = Schema.Struct({
  definitionId: DefinitionId,
  revision: Schema.Int,
});

export class PublishProductConfigurationError extends Schema.TaggedError<PublishProductConfigurationError>()(
  'PublishProductConfigurationError',
  {
    code: Schema.Literals([
      'product_configuration_invalid',
      'product_configuration_not_found',
      'product_configuration_stale',
      'product_configuration_unavailable',
    ]),
    reason: Schema.String,
  },
) {}
