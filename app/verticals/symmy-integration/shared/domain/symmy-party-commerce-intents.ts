import { ChangeOrganizationCustomerProfileIcoPayloadSchema } from '@app/commerce-customer-context/domain/organization-profile-ico';
import { OrganizationBusinessSourceReferenceSchema } from '@app/party-registry/apis/organization-record-facts';
import { AddSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/add-saved-address-action';
import { UpdateSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/update-saved-address-action';
import { RemoveSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/remove-saved-address-action';
import {
  AddContactPointPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  EndContactPointPayloadSchema,
  UpdateContactPointPayloadSchema,
  CorrectPartyFactPayloadSchema,
  CreatePartyPayloadSchema,
  MatchPartyPayloadSchema,
  ResolvePartyCommandCommitPayloadSchema,
  UpdatePartyPayloadSchema,
} from '@app/party-registry/api';
import { AssignCustomerPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-customer-price-group-action';
import { AssignCounterpartyPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-counterparty-price-group-action';
import { CustomerPriceGroupAssignmentReceiptRequestSchema } from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { ChangeCustomerProfileIcoPayloadSchema } from '@app/commerce-customer-context/api/change-customer-profile-ico-action';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '@app/commerce-customer-context/api/create-counterparty-purchasing-profile-action';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { EnsureRetailCustomerProfilePayloadSchema } from '@app/commerce-customer-context/api/ensure-retail-customer-profile-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import { Match, Option, Schema, Struct } from 'effect';
import type { SymmyOwnerEffectRef } from '@app/shared-contracts/symmy';
import { PartySourceContactResultSchema } from '@app/party-registry/apis/party-source-effect-receipt';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PartyContactPointRefSchema } from '@app/party-registry/resources/party-contact-point';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { RetailCustomerProfileRefSchema } from '@app/commerce-customer-context/resources/retail-customer-profile';
import { CounterpartyPurchasingProfileRefSchema } from '@app/commerce-customer-context/resources/counterparty-purchasing-profile';

const dependencyKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u));
const partyDependency = Schema.Struct({
  effectKey: dependencyKey.pipe(Schema.brand('SymmyPartyDependencyEffectKey')),
  itemKey: dependencyKey.pipe(Schema.brand('SymmyPartyDependencyItemKey')),
});
const retailSubject = EnsureRetailCustomerProfilePayloadSchema.fields.subject.fields;
const retailProfileFromPartyPayload = Schema.Struct({
  ...EnsureRetailCustomerProfilePayloadSchema.fields,
  subject: Schema.Struct({ kind: retailSubject.kind, sellingLegalEntityRef: retailSubject.sellingLegalEntityRef }),
});

const onboardFromPartyPayload = Schema.Struct({
  counterpartyProvenance: CounterpartyCustomerOnboardPayloadSchema.fields.counterpartyProvenance,
  customerEvidence: CounterpartyCustomerOnboardPayloadSchema.fields.customerEvidence,
  sourceReference: CounterpartyCustomerOnboardPayloadSchema.fields.sourceReference,
  validFrom: CounterpartyCustomerOnboardPayloadSchema.fields.validFrom,
  validTo: CounterpartyCustomerOnboardPayloadSchema.fields.validTo,
});
const contactFromPartyPayload = Schema.Struct({
  contactPoint: AddContactPointPayloadSchema.fields.contactPoint,
  privacyClassification: AddContactPointPayloadSchema.fields.privacyClassification,
  provenance: AddContactPointPayloadSchema.fields.provenance,
  sourceReference: AddContactPointPayloadSchema.fields.sourceReference,
  validFrom: AddContactPointPayloadSchema.fields.validFrom,
});
const counterpartySubject = CreateCounterpartyPurchasingProfilePayloadSchema.fields.subject.fields;
const counterpartyProfileFromCounterpartyPayload = Schema.Struct({
  ...Struct.omit(CreateCounterpartyPurchasingProfilePayloadSchema.fields, ['sourceOrganizationWitness']),
  subject: Schema.Struct({
    kind: counterpartySubject.kind,
    sellingLegalEntityRef: counterpartySubject.sellingLegalEntityRef,
  }),
});

const savedAddressFromReceiptsPayload = Schema.Struct({
  label: AddSavedAddressPayloadSchema.fields.label,
  purposes: AddSavedAddressPayloadSchema.fields.purposes,
  reason: AddSavedAddressPayloadSchema.fields.reason,
  source: AddSavedAddressPayloadSchema.fields.source,
});

/** Internal normalized inputs retain the complete native owner contract, including evidence and meaning. */
export const SymmyPartyCommerceIntentSchema = Schema.Union([
  Schema.TaggedStruct('AddSavedAddress', { payload: Schema.toEncoded(AddSavedAddressPayloadSchema) }),
  Schema.TaggedStruct('UpdateSavedAddress', { payload: Schema.toEncoded(UpdateSavedAddressPayloadSchema) }),
  Schema.TaggedStruct('RemoveSavedAddress', { payload: Schema.toEncoded(RemoveSavedAddressPayloadSchema) }),
  Schema.TaggedStruct('AddSavedRetailAddressFromOwnerReceipts', {
    fromContactPointEffect: partyDependency,
    fromProfileEffect: partyDependency,
    payload: Schema.toEncoded(savedAddressFromReceiptsPayload),
  }),
  Schema.TaggedStruct('AddSavedCounterpartyAddressFromOwnerReceipts', {
    fromContactPointEffect: partyDependency,
    fromCounterpartyEffect: partyDependency,
    fromProfileEffect: partyDependency,
    payload: Schema.toEncoded(savedAddressFromReceiptsPayload),
  }),
  Schema.TaggedStruct('OnboardCounterpartyCustomer', {
    payload: Schema.toEncoded(CounterpartyCustomerOnboardPayloadSchema),
  }),
  Schema.TaggedStruct('AddPartyContactPoint', { payload: Schema.toEncoded(AddContactPointPayloadSchema) }),
  Schema.TaggedStruct('UpdatePartyContactPoint', { payload: Schema.toEncoded(UpdateContactPointPayloadSchema) }),
  Schema.TaggedStruct('EndPartyContactPoint', { payload: Schema.toEncoded(EndContactPointPayloadSchema) }),
  Schema.TaggedStruct('OnboardCounterpartyCustomerFromParty', {
    fromPartyEffect: partyDependency,
    payload: Schema.toEncoded(onboardFromPartyPayload),
  }),
  Schema.TaggedStruct('AddPartyContactPointFromParty', {
    fromPartyEffect: partyDependency,
    payload: Schema.toEncoded(contactFromPartyPayload),
  }),
  Schema.TaggedStruct('CreateCounterpartyProfileFromCounterparty', {
    fromCounterpartyEffect: partyDependency,
    payload: Schema.toEncoded(counterpartyProfileFromCounterpartyPayload),
  }),

  Schema.TaggedStruct('EnsureRetailProfileFromParty', {
    fromPartyEffect: partyDependency,
    payload: Schema.toEncoded(retailProfileFromPartyPayload),
  }),

  Schema.TaggedStruct('AssignCustomerPriceGroup', {
    authorizationSubject: CustomerPriceGroupAssignmentReceiptRequestSchema.fields.authorizationSubject,
    payload: Schema.toEncoded(AssignCustomerPriceGroupPayloadSchema),
  }),
  Schema.TaggedStruct('AssignCounterpartyPriceGroup', {
    authorizationSubject: CustomerPriceGroupAssignmentReceiptRequestSchema.fields.authorizationSubject,
    payload: Schema.toEncoded(AssignCounterpartyPriceGroupPayloadSchema),
  }),
  Schema.TaggedStruct('PartyCreate', { payload: Schema.toEncoded(CreatePartyPayloadSchema) }),
  Schema.TaggedStruct('PartyMatch', { payload: Schema.toEncoded(MatchPartyPayloadSchema) }),
  Schema.TaggedStruct('PartyUpdate', { payload: Schema.toEncoded(UpdatePartyPayloadSchema) }),
  Schema.TaggedStruct('PartyCorrect', { payload: Schema.toEncoded(CorrectPartyFactPayloadSchema) }),
  Schema.TaggedStruct('CustomerGroupCreate', { payload: Schema.toEncoded(CreateCustomerGroupPayloadSchema) }),
  Schema.TaggedStruct('CustomerGroupUpdate', { payload: Schema.toEncoded(UpdateCustomerGroupPayloadSchema) }),
  Schema.TaggedStruct('CustomerGroupMembership', {
    payload: Schema.toEncoded(ApplyCustomerGroupMembershipSourcePayloadSchema),
  }),
  Schema.TaggedStruct('OrganizationCustomerProfileIco', {
    payload: Schema.toEncoded(ChangeOrganizationCustomerProfileIcoPayloadSchema),
    sourceReference: OrganizationBusinessSourceReferenceSchema,
  }),
  Schema.TaggedStruct('CustomerProfileIco', { payload: Schema.toEncoded(ChangeCustomerProfileIcoPayloadSchema) }),
  Schema.TaggedStruct('EnsureRetailProfile', { payload: Schema.toEncoded(EnsureRetailCustomerProfilePayloadSchema) }),
  Schema.TaggedStruct('CreateCounterpartyProfile', {
    payload: Schema.toEncoded(CreateCounterpartyPurchasingProfilePayloadSchema),
  }),
]);
export type SymmyPartyCommerceIntent = typeof SymmyPartyCommerceIntentSchema.Type;

const invocationId = Schema.optionalKey(ResolvePartyCommandCommitPayloadSchema.fields.invocationId);
/** Minimal private dependency receipts; no names, contacts or source document bodies. */
export const SymmyPartyCommerceOwnerReceiptSchema = Schema.Union([
  Schema.TaggedStruct('CounterpartyCustomerOnboarded', {
    actionInvocationId: invocationId,
    counterpartyRef: CounterpartyRefSchema,
    legalEntityRef: Schema.optionalKey(CounterpartyCustomerOnboardResultSchema.fields.legalEntityRef),
    partyRef: PartyRefSchema,
    rolePeriodRef: Schema.optionalKey(CounterpartyCustomerOnboardResultSchema.fields.rolePeriodRef),
  }),
  Schema.TaggedStruct('PartyContactPointAdded', {
    actionInvocationId: invocationId,
    contactPointRef: PartyContactPointRefSchema,
    partyRef: PartyRefSchema,
    revision: PartySourceContactResultSchema.fields.revision,
  }),

  Schema.TaggedStruct('PartyCreated', { actionInvocationId: invocationId, partyRef: PartyRefSchema }),
  Schema.TaggedStruct('PartyMatched', { actionInvocationId: invocationId, partyRef: PartyRefSchema }),
  Schema.TaggedStruct('RetailProfileEnsured', {
    actionInvocationId: invocationId,
    partyRef: PartyRefSchema,
    profileRef: RetailCustomerProfileRefSchema,
  }),
  Schema.TaggedStruct('CounterpartyProfileCreated', {
    actionInvocationId: invocationId,
    counterpartyRef: CounterpartyRefSchema,
    profileRef: CounterpartyPurchasingProfileRefSchema,
  }),
]);
export type SymmyPartyCommerceOwnerReceipt = typeof SymmyPartyCommerceOwnerReceiptSchema.Type;

/** Only the integration effect's bookkeeping identity is assigned here. Source occurrence is preserved. */
export const materializeSymmyPartyCommerceIntent = (
  intent: SymmyPartyCommerceIntent,
  ref: SymmyOwnerEffectRef,
): SymmyPartyCommerceIntent =>
  Match.value(intent).pipe(
    Match.tags({
      AddPartyContactPoint: (value) => value,
      AddPartyContactPointFromParty: (value) => value,
      AddSavedAddress: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      AddSavedCounterpartyAddressFromOwnerReceipts: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      AddSavedRetailAddressFromOwnerReceipts: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      AssignCounterpartyPriceGroup: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      AssignCustomerPriceGroup: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      CreateCounterpartyProfile: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      CreateCounterpartyProfileFromCounterparty: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      CustomerGroupCreate: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      CustomerGroupMembership: (value) => ({
        ...value,
        payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } },
      }),
      CustomerGroupUpdate: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      CustomerProfileIco: (value) => ({ ...value, payload: { ...value.payload, effectId: ref.effectId } }),
      EndPartyContactPoint: (value) => value,
      EnsureRetailProfile: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      EnsureRetailProfileFromParty: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      OnboardCounterpartyCustomer: (value) => value,
      OnboardCounterpartyCustomerFromParty: (value) => value,
      OrganizationCustomerProfileIco: (value) => ({ ...value, payload: { ...value.payload, effectId: ref.effectId } }),
      PartyCorrect: (value) => value,
      PartyCreate: (value) => value,
      PartyMatch: (value) => value,
      PartyUpdate: (value) => value,
      RemoveSavedAddress: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
      UpdatePartyContactPoint: (value) => value,
      UpdateSavedAddress: (value) =>
        value.payload.source === undefined
          ? value
          : { ...value, payload: { ...value.payload, source: { ...value.payload.source, effectId: ref.effectId } } },
    }),
    Match.exhaustive,
  );

/** Resolve only the one canonical Party returned by the explicitly named successful parent effect. */
export const resolveSymmyRetailProfileParty = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfileFromParty' }>,
  receipt: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'PartyCreated' | 'PartyMatched' }>,
): Extract<SymmyPartyCommerceIntent, { readonly _tag: 'EnsureRetailProfile' }> => ({
  _tag: 'EnsureRetailProfile',
  payload: { ...intent.payload, subject: { ...intent.payload.subject, partyRef: receipt.partyRef } },
});

export const resolveSymmyCounterpartyOnboardParty = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'OnboardCounterpartyCustomerFromParty' }>,
  receipt: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'PartyCreated' | 'PartyMatched' }>,
): Extract<SymmyPartyCommerceIntent, { readonly _tag: 'OnboardCounterpartyCustomer' }> => ({
  _tag: 'OnboardCounterpartyCustomer',
  payload: { ...intent.payload, partyRef: receipt.partyRef },
});
export const resolveSymmyContactPointParty = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddPartyContactPointFromParty' }>,
  receipt: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'PartyCreated' | 'PartyMatched' }>,
): Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddPartyContactPoint' }> => ({
  _tag: 'AddPartyContactPoint',
  payload: { ...intent.payload, partyRef: receipt.partyRef },
});
export const resolveSymmyCounterpartyProfileCounterparty = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CreateCounterpartyProfileFromCounterparty' }>,
  receipt: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'CounterpartyCustomerOnboarded' }>,
): Extract<SymmyPartyCommerceIntent, { readonly _tag: 'CreateCounterpartyProfile' }> => ({
  _tag: 'CreateCounterpartyProfile',
  payload: { ...intent.payload, subject: { ...intent.payload.subject, counterpartyRef: receipt.counterpartyRef } },
});

/** A saved address cites the actual acknowledged ContactPoint and its actual profile owner. */
export const resolveSymmyRetailSavedAddress = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedRetailAddressFromOwnerReceipts' }>,
  profile: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'RetailProfileEnsured' }>,
  contact: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'PartyContactPointAdded' }>,
): Option.Option<Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedAddress' }>> =>
  profile.partyRef.resourceId === contact.partyRef.resourceId && profile.partyRef.tenantId === contact.partyRef.tenantId
    ? Option.some({
        _tag: 'AddSavedAddress',
        payload: {
          ...intent.payload,
          origin: {
            contactPointRef: contact.contactPointRef,
            kind: 'PARTY_BACKED',
            partyRef: contact.partyRef,
            sourceRevision: contact.revision,
          },
          profile: { kind: 'RETAIL', profileRef: profile.profileRef },
        },
      })
    : Option.none();
export const resolveSymmyCounterpartySavedAddress = (
  intent: Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedCounterpartyAddressFromOwnerReceipts' }>,
  profile: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'CounterpartyProfileCreated' }>,
  contact: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'PartyContactPointAdded' }>,
  counterparty: Extract<SymmyPartyCommerceOwnerReceipt, { readonly _tag: 'CounterpartyCustomerOnboarded' }>,
): Option.Option<Extract<SymmyPartyCommerceIntent, { readonly _tag: 'AddSavedAddress' }>> =>
  profile.counterpartyRef.resourceId === counterparty.counterpartyRef.resourceId &&
  profile.counterpartyRef.tenantId === counterparty.counterpartyRef.tenantId &&
  counterparty.partyRef.resourceId === contact.partyRef.resourceId &&
  counterparty.partyRef.tenantId === contact.partyRef.tenantId
    ? Option.some({
        _tag: 'AddSavedAddress',
        payload: {
          ...intent.payload,
          origin: {
            contactPointRef: contact.contactPointRef,
            kind: 'PARTY_BACKED',
            partyRef: contact.partyRef,
            sourceRevision: contact.revision,
          },
          profile: {
            counterpartyRef: counterparty.counterpartyRef,
            kind: 'COUNTERPARTY',
            profileRef: profile.profileRef,
          },
        },
      })
    : Option.none();
