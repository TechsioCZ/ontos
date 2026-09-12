import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { PaymentTermRefSchema } from '../resources/payment-term.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const boundedText = (maximum: number) => nonEmptyText.check(Schema.isMaxLength(maximum));

export const PaymentTermInstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  }),
);

export const PaymentTermMillisecondInstantSchema = Schema.toEncoded(PaymentTermInstantSchema).check(
  Schema.makeFilter((value) =>
    value.length === 24 ? undefined : 'Expected a canonical UTC timestamp with milliseconds',
  ),
);

export const PaymentTermCodeSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
);

export const PaymentTermNameSchema = boundedText(160);
export const PaymentTermDescriptionSchema = boundedText(2000);
export const PaymentTermReasonSchema = boundedText(1000);
const checkedRevisionId = Schema.String.check(Schema.isUUID());
export const PaymentTermDefinitionRevisionIdSchema = checkedRevisionId.pipe(
  Schema.brand('PaymentTermDefinitionRevisionId'),
  Schema.decodeTo(checkedRevisionId),
);
export const PaymentTermRevisionIdSchema = checkedRevisionId.pipe(
  Schema.brand('PaymentTermRevisionId'),
  Schema.decodeTo(checkedRevisionId),
);
const checkedCompatibilityId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z][a-z0-9._-]*$/u),
);
export const PaymentTermCompatibilityIdSchema = checkedCompatibilityId.pipe(
  Schema.brand('PaymentTermCompatibilityId'),
  Schema.decodeTo(checkedCompatibilityId),
);
export const PaymentTermSemanticFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const PaymentTermConsumerCompatibilitySchema = Schema.Literal('customer-payment-terms.v1');

export const ImmediatePaymentTermSemanticsSchema = Schema.Struct({
  calculationRuleVersion: Schema.Literal(1),
  calendarRule: Schema.Literal('NOT_APPLICABLE'),
  kind: Schema.Literal('IMMEDIATE'),
});
export type ImmediatePaymentTermSemantics = typeof ImmediatePaymentTermSemanticsSchema.Type;

export const NetDaysPaymentTermSemanticsSchema = Schema.Struct({
  calculationRuleVersion: Schema.Literal(1),
  calendarRule: Schema.Literal('CALENDAR_DAYS_UTC'),
  days: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  dueDateAnchor: Schema.Literal('INVOICE_ISSUED_AT'),
  kind: Schema.Literal('NET_DAYS'),
});
export type NetDaysPaymentTermSemantics = typeof NetDaysPaymentTermSemanticsSchema.Type;

export const PaymentTermSemanticsSchema = Schema.Union([
  ImmediatePaymentTermSemanticsSchema,
  NetDaysPaymentTermSemanticsSchema,
]);
export type PaymentTermSemantics = typeof PaymentTermSemanticsSchema.Type;

export const PaymentTermLifecycleSchema = Schema.Struct({
  effectiveFrom: PaymentTermInstantSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the stable wire sentinel for an open-ended lifecycle; expires: 2027-03-31.
  effectiveTo: Schema.NullOr(PaymentTermInstantSchema),
  state: Schema.Literals(['ACTIVE', 'RETIRED']),
});
export type PaymentTermLifecycle = typeof PaymentTermLifecycleSchema.Type;

export const PaymentTermProvenanceSchema = Schema.Struct({
  actionInvocationId: Schema.toEncoded(nonEmptyText.pipe(Schema.brand('PaymentTermActionInvocationId'))),
  actorPrincipalId: Schema.toEncoded(nonEmptyText.pipe(Schema.brand('PaymentTermActorPrincipalId'))),
  at: PaymentTermInstantSchema,
  reason: PaymentTermReasonSchema,
});
export type PaymentTermProvenance = typeof PaymentTermProvenanceSchema.Type;

const PaymentTermDefinitionFieldsSchema = Schema.Struct({
  code: PaymentTermCodeSchema,
  compatibilityId: PaymentTermCompatibilityIdSchema,
  compatibleWith: Schema.Array(PaymentTermConsumerCompatibilitySchema),
  created: PaymentTermProvenanceSchema,
  definitionRevisionId: PaymentTermDefinitionRevisionIdSchema,
  description: PaymentTermDescriptionSchema,
  lifecycle: PaymentTermLifecycleSchema,
  metadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  name: PaymentTermNameSchema,
  paymentTermRef: PaymentTermRefSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the stable public wire sentinel for a definition that has not been retired; expires: 2027-03-31.
  retired: Schema.NullOr(PaymentTermProvenanceSchema),
  semanticFingerprint: PaymentTermSemanticFingerprintSchema,
  semanticRevisionId: PaymentTermRevisionIdSchema,
  semantics: PaymentTermSemanticsSchema,
  updated: PaymentTermProvenanceSchema,
});
export const PaymentTermDefinitionSchema = PaymentTermDefinitionFieldsSchema.check(
  Schema.makeFilter((definition) => {
    const scheduledOrRetired =
      definition.lifecycle.state === 'RETIRED' &&
      definition.lifecycle.effectiveTo !== null &&
      definition.retired !== null;
    const active =
      definition.lifecycle.state === 'ACTIVE' &&
      definition.lifecycle.effectiveTo === null &&
      definition.retired === null;
    if (!active && !scheduledOrRetired) {
      return 'Lifecycle state, effective end, and retirement provenance must agree';
    }
    if (
      definition.lifecycle.effectiveTo !== null &&
      definition.lifecycle.effectiveTo < definition.lifecycle.effectiveFrom
    ) {
      return 'Payment Term retirement cannot precede activation';
    }
    if (!definition.compatibleWith.includes('customer-payment-terms.v1')) {
      return 'Launch Payment Terms must declare customer-payment-terms.v1 compatibility';
    }
    return true;
  }),
);
export type PaymentTermDefinition = typeof PaymentTermDefinitionSchema.Type;

export const PaymentTermAliasSchema = Schema.Struct({
  aliasRef: PaymentTermRefSchema,
  canonicalRef: PaymentTermRefSchema,
  reconciled: PaymentTermProvenanceSchema,
});
export type PaymentTermAlias = typeof PaymentTermAliasSchema.Type;

export const PaymentTermAuditEvidenceSchema = Schema.Struct({
  affectedUseDispositionKind: Schema.optionalKey(
    Schema.Literals(['REJECT_IF_IN_USE', 'EXPLICIT_MIGRATION', 'GRACE_POLICY']),
  ),
  affectedUseEvidenceReference: Schema.optionalKey(nonEmptyText),
  affectedUseHandlingReference: Schema.optionalKey(nonEmptyText),
  affectedUseObservedAt: Schema.optionalKey(PaymentTermInstantSchema),
  currentCustomerEntitlementCount: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  openPurchaseCount: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  reason: PaymentTermReasonSchema,
});

export const PaymentTermAffectedUseAssessmentSchema = Schema.Struct({
  currentCustomerEntitlementCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  evidenceReference: nonEmptyText,
  observedAt: PaymentTermMillisecondInstantSchema,
  openPurchaseCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type PaymentTermAffectedUseAssessment = typeof PaymentTermAffectedUseAssessmentSchema.Type;

export const PaymentTermAffectedUseDispositionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('REJECT_IF_IN_USE') }),
  Schema.Struct({
    kind: Schema.Literal('EXPLICIT_MIGRATION'),
    migrationReference: nonEmptyText,
  }),
  Schema.Struct({
    gracePolicyReference: nonEmptyText,
    kind: Schema.Literal('GRACE_POLICY'),
  }),
]);
export type PaymentTermAffectedUseDisposition = typeof PaymentTermAffectedUseDispositionSchema.Type;

export const PaymentTermDueDateInputSchema = Schema.Struct({
  acceptedAt: PaymentTermInstantSchema,
  invoiceIssuedAt: Schema.optionalKey(PaymentTermInstantSchema),
});
export type PaymentTermDueDateInput = typeof PaymentTermDueDateInputSchema.Type;

export const PaymentTermDueDateResultSchema = Schema.Union([
  Schema.Struct({ dueAt: PaymentTermInstantSchema, kind: Schema.Literal('CALCULATED') }),
  Schema.Struct({
    anchor: Schema.Literal('INVOICE_ISSUED_AT'),
    kind: Schema.Literal('MISSING_ANCHOR'),
  }),
  Schema.Struct({
    kind: Schema.Literal('OUT_OF_RANGE'),
    reason: Schema.Literal('DUE_DATE_OUTSIDE_SUPPORTED_INSTANT_RANGE'),
  }),
]);
export type PaymentTermDueDateResult = typeof PaymentTermDueDateResultSchema.Type;
