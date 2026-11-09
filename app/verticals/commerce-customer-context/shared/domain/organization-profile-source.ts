import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Effect, Schema } from 'effect';
import {
  CreateCounterpartyPurchasingProfilePayloadSchema,
  CreateCounterpartyPurchasingProfileResultSchema,
} from '../actions/create-counterparty-purchasing-profile.ts';
import { ProfileInstantSchema } from './profile-contracts.ts';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import {
  CustomerProfilePartySourceReferenceSchema,
  CustomerProfileSourceAssertionSchema,
} from './customer-profile-source.ts';

export const ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION =
  'commerce.customer-context.organization-profile-create-fields.v1';
export const ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION =
  'commerce.customer-context.organization-profile-source-fields.v1';
export const ORGANIZATION_PROFILE_SOURCE_RECEIPT_VERSION =
  'commerce.customer-context.organization-profile-source-receipt-fields.v1';
export const ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS = [
  'subject.kind',
  'subject.counterpartyRef',
  'subject.sellingLegalEntityRef',
  'effectiveAt',
  'trigger',
  'source.issuer',
  'source.namespace',
  'source.recordType',
  'source.route.id',
  'source.route.revision',
  'source.mappingRevision',
  'source.recordId',
  'source.occurrenceId',
  'source.effectId',
  'source.revision',
  'source.order',
  'partySourceReference.source.issuer',
  'partySourceReference.source.namespace',
  'partySourceReference.source.recordType',
  'partySourceReference.source.routeRef',
  'partySourceReference.recordId',
  'partySourceReference.occurrenceId',
] as const;
export const ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS = [
  'profile.profileRef',
  'profile.revision',
  'profile.state',
  'profile.subject.kind',
  'profile.subject.counterpartyRef',
  'partyRef',
  'source.issuer',
  'source.namespace',
  'source.recordType',
  'source.route.id',
  'source.route.revision',
  'source.mappingRevision',
  'source.recordId',
  'source.occurrenceId',
  'source.effectId',
  'source.revision',
  'source.order',
  'partySourceReference.source.issuer',
  'partySourceReference.source.namespace',
  'partySourceReference.source.recordType',
  'partySourceReference.source.routeRef',
  'partySourceReference.recordId',
  'partySourceReference.occurrenceId',
] as const;
export const ORGANIZATION_PROFILE_SOURCE_RECEIPT_FIELDS = [
  'receipt.actionInvocationId',
  'receipt.profileKind',
  'receipt.recordedAt',
  'receipt.intent.subject.kind',
  'receipt.intent.subject.counterpartyRef',
  'receipt.intent.effectiveAt',
  'receipt.intent.trigger',
  'receipt.intent.source.issuer',
  'receipt.intent.source.namespace',
  'receipt.intent.source.recordType',
  'receipt.intent.source.route.id',
  'receipt.intent.source.route.revision',
  'receipt.intent.source.mappingRevision',
  'receipt.intent.source.recordId',
  'receipt.intent.source.occurrenceId',
  'receipt.intent.source.effectId',
  'receipt.intent.source.revision',
  'receipt.intent.source.order',
  'receipt.intent.partySourceReference.source.issuer',
  'receipt.intent.partySourceReference.source.namespace',
  'receipt.intent.partySourceReference.source.recordType',
  'receipt.intent.partySourceReference.source.routeRef',
  'receipt.intent.partySourceReference.recordId',
  'receipt.intent.partySourceReference.occurrenceId',
  'receipt.result.outcome',
  'receipt.result.profileRef',
  'receipt.result.revision',
  'receipt.result.state',
  'receipt.result.sourceEffect.effectId',
  'receipt.result.sourceEffect.replayed',
] as const;

export const OrganizationProfileSourceCreateSchema = Schema.Struct({
  effectiveAt: CreateCounterpartyPurchasingProfilePayloadSchema.fields.effectiveAt,
  partySourceReference: CustomerProfilePartySourceReferenceSchema,
  source: CustomerProfileSourceAssertionSchema,
  subject: Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    sellingLegalEntityRef: CreateCounterpartyPurchasingProfilePayloadSchema.fields.subject.fields.sellingLegalEntityRef,
  }),
  trigger: CreateCounterpartyPurchasingProfilePayloadSchema.fields.trigger,
});

/** A finite projection of the existing immutable effect receipt; it is not a new owner ledger. */
export const OrganizationProfileSourceReceiptSchema = Schema.Struct({
  actionInvocationId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'))),
  intent: Schema.Struct({
    ...OrganizationProfileSourceCreateSchema.fields,
    subject: Schema.Struct({ counterpartyRef: CounterpartyRefSchema, kind: Schema.Literal('COUNTERPARTY') }),
  }),
  profileKind: Schema.Literal('COUNTERPARTY'),
  recordedAt: ProfileInstantSchema,
  result: CreateCounterpartyPurchasingProfileResultSchema,
});
export type OrganizationProfileSourceReceipt = typeof OrganizationProfileSourceReceiptSchema.Type;

export const OrganizationProfileSourceCurrentSchema = Schema.Struct({
  partyRef: PartyRefSchema,
  partySourceReference: CustomerProfilePartySourceReferenceSchema,
  profile: Schema.Struct({
    profileRef: Schema.Struct({
      ...CounterpartyPurchasingProfileRefSchema.fields,
      kind: Schema.Literal('COUNTERPARTY'),
    }),
    revision: CreateCounterpartyPurchasingProfileResultSchema.fields.revision,
    state: CreateCounterpartyPurchasingProfileResultSchema.fields.state,
    subject: OrganizationProfileSourceReceiptSchema.fields.intent.fields.subject,
  }),
  source: CustomerProfileSourceAssertionSchema,
});

export const ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION =
  'commerce.customer-context.organization-profile-create-template-fields.v1';
const NamedDependencyKeySchema = Schema.toEncoded(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u)).pipe(
    Schema.brand('OrganizationProfileSourceDependencyKey'),
  ),
);
/** Matches the accepted source-only runtime template, with no future native Counterparty identifier. */
export const OrganizationProfileSourceCreateTemplateSchema = Schema.TaggedStruct(
  'CreateCounterpartyProfileFromCounterparty',
  {
    fromCounterpartyEffect: Schema.Struct({ effectKey: NamedDependencyKeySchema, itemKey: NamedDependencyKeySchema }),
    payload: Schema.Struct({
      effectiveAt: CreateCounterpartyPurchasingProfilePayloadSchema.fields.effectiveAt,
      partySourceReference: CustomerProfilePartySourceReferenceSchema,
      source: CustomerProfileSourceAssertionSchema,
      subject: Schema.Struct({
        kind: Schema.Literal('COUNTERPARTY'),
        sellingLegalEntityRef: Schema.requiredKey(
          CreateCounterpartyPurchasingProfilePayloadSchema.fields.subject.fields.sellingLegalEntityRef,
        ),
      }),
      trigger: CreateCounterpartyPurchasingProfilePayloadSchema.fields.trigger,
    }),
  },
);
export const ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_FIELDS = [
  '_tag',
  'fromCounterpartyEffect.effectKey',
  'fromCounterpartyEffect.itemKey',
  'payload.subject.kind',
  'payload.subject.sellingLegalEntityRef',
  'payload.effectiveAt',
  'payload.trigger',
  'payload.source.issuer',
  'payload.source.namespace',
  'payload.source.recordType',
  'payload.source.route.id',
  'payload.source.route.revision',
  'payload.source.mappingRevision',
  'payload.source.recordId',
  'payload.source.occurrenceId',
  'payload.source.effectId',
  'payload.source.revision',
  'payload.source.order',
  'payload.partySourceReference.source.issuer',
  'payload.partySourceReference.source.namespace',
  'payload.partySourceReference.source.recordType',
  'payload.partySourceReference.source.routeRef',
  'payload.partySourceReference.recordId',
  'payload.partySourceReference.occurrenceId',
] as const;
export type OrganizationProfileSourceCreateTemplateInput = typeof OrganizationProfileSourceCreateTemplateSchema.Encoded;
export const fingerprintOrganizationProfileSourceCreateTemplate = (
  input: OrganizationProfileSourceCreateTemplateInput,
) =>
  Schema.decodeUnknownEffect(OrganizationProfileSourceCreateTemplateSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.flatMap(Schema.encodeEffect(OrganizationProfileSourceCreateTemplateSchema)),
    Effect.map(computeCanonicalValueHash),
  );

/** Strict native command projection: the sole omitted field is its declared execution locator. */
export const fingerprintOrganizationProfileSourceCreate = (
  input: typeof CreateCounterpartyPurchasingProfilePayloadSchema.Encoded,
) =>
  Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema, { onExcessProperty: 'error' })(
    input,
  ).pipe(
    Effect.flatMap((decoded) => {
      const { sourceOrganizationWitness: _witness, ...business } = decoded;
      return Schema.decodeUnknownEffect(OrganizationProfileSourceCreateSchema, { onExcessProperty: 'error' })(business);
    }),
    Effect.flatMap(Schema.encodeEffect(OrganizationProfileSourceCreateSchema)),
    Effect.map(computeCanonicalValueHash),
  );
