import { Schema } from 'effect';
import {
  PaymentTermCanonicalSemanticsSchema,
  PaymentTermCodeSchema,
  PaymentTermDefinitionSchema,
  PaymentTermDescriptionSchema,
  PaymentTermInstantSchema,
  PaymentTermNameSchema,
  PaymentTermReasonSchema,
} from './payment-term.ts';

const text = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200));
export const PaymentTermSourceRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
);
const revision = PaymentTermSourceRevisionSchema;
const brandedText = (brand: string) => text.pipe(Schema.brand(brand), Schema.decodeTo(text));
export const ExternalBusinessSystemIdSchema = brandedText('ExternalBusinessSystemId');
export const SourceRecordIdSchema = brandedText('SourceRecordId');
export const SourceStatementIdSchema = brandedText('SourceStatementId');
const checkedId = Schema.String.check(Schema.isUUID());
const IngestPrincipalIdSchema = checkedId.pipe(Schema.brand('IngestPrincipalId'), Schema.decodeTo(checkedId));
const PaymentTermIdSchema = checkedId.pipe(Schema.brand('PaymentTermId'), Schema.decodeTo(checkedId));
export const PaymentTermSourceKeySchema = Schema.Struct({
  externalBusinessSystemId: ExternalBusinessSystemIdSchema,
  integrationRoute: text,
  namespace: text,
  sourceRecordId: SourceRecordIdSchema,
  sourceStatementId: SourceStatementIdSchema,
});
export const PaymentTermSourceRecordKeySchema = Schema.Struct({
  externalBusinessSystemId: ExternalBusinessSystemIdSchema,
  integrationRoute: text,
  namespace: text,
  sourceRecordId: SourceRecordIdSchema,
});
export const ConfigurePaymentTermSourceAuthorityPayloadSchema = Schema.Struct({
  expectedRevision: revision,
  externalBusinessSystemId: ExternalBusinessSystemIdSchema,
  ingestPrincipalId: IngestPrincipalIdSchema,
  integrationRoute: text,
  namespace: text,
  reason: PaymentTermReasonSchema,
});
export const ConfigurePaymentTermSourceAuthorityResultSchema = Schema.Union([
  Schema.TaggedStruct('configured', { authorityRevision: revision }),
  Schema.TaggedStruct('revision_conflict', { actualRevision: revision }),
]);
export const AcceptPaymentTermSourceStatementPayloadSchema = Schema.Struct({
  ...PaymentTermSourceKeySchema.fields,
  businessObservedAt: PaymentTermInstantSchema,
  mapping: Schema.Union([
    Schema.Struct({
      activeFrom: PaymentTermInstantSchema,
      code: PaymentTermCodeSchema,
      description: PaymentTermDescriptionSchema,
      kind: Schema.Literal('CREATE'),
      name: PaymentTermNameSchema,
    }),
    Schema.Struct({ kind: Schema.Literal('EXISTING'), paymentTermId: PaymentTermIdSchema }),
  ]),
  reason: PaymentTermReasonSchema,
  semantics: Schema.Union([
    PaymentTermCanonicalSemanticsSchema,
    Schema.Struct({ evidence: text, kind: Schema.Literal('UNSUPPORTED') }),
  ]),
  sourceCode: text,
  sourceRevision: revision,
});
export const AcceptPaymentTermSourceStatementResultSchema = Schema.Union([
  Schema.TaggedStruct('ACCEPTED', {
    authorityRevision: revision,
    definition: PaymentTermDefinitionSchema,
    receivedAt: PaymentTermInstantSchema,
    sourceRevision: revision,
    sourceStatementId: SourceStatementIdSchema,
  }),
  Schema.TaggedStruct('REJECTED', {
    reason: Schema.Literals([
      'UNAUTHORIZED_SOURCE',
      'UNSUPPORTED_SEMANTICS',
      'STATEMENT_CONFLICT',
      'STALE_REVISION',
      'AMBIGUOUS_MAPPING',
      'BUSINESS_CODE_CONFLICT',
      'DUPLICATE_SEMANTICS',
      'MISSING_REFERENCE',
      'INCOMPATIBLE_REFERENCE',
      'INACTIVE_REFERENCE',
    ]),
    sourceRevision: revision,
    sourceStatementId: SourceStatementIdSchema,
  }),
]);
export type ConfigurePaymentTermSourceAuthorityPayload = typeof ConfigurePaymentTermSourceAuthorityPayloadSchema.Type;
export type ConfigurePaymentTermSourceAuthorityResult = typeof ConfigurePaymentTermSourceAuthorityResultSchema.Type;
export type AcceptPaymentTermSourceStatementPayload = typeof AcceptPaymentTermSourceStatementPayloadSchema.Type;
export type AcceptPaymentTermSourceStatementResult = typeof AcceptPaymentTermSourceStatementResultSchema.Type;
export type PaymentTermSourceKey = typeof PaymentTermSourceKeySchema.Type;
