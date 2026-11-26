import { SymmyInternalCustomersProjectionSchema } from './read-projection-contracts.ts';
import type { SymmyInternalCustomersProjection } from './read-projection-contracts.ts';
import { Schema, Struct } from 'effect';

const projectionFields = SymmyInternalCustomersProjectionSchema.fields;
const customerFields = projectionFields.customers.value.fields;

const profileFields = customerFields.profile.fields;
const [retailProfile, counterpartyProfile] = profileFields.profileRef.members;
const [retailSubject, counterpartySubject] = profileFields.subject.members;
const sellingLegalEntityId = retailSubject.fields.sellingLegalEntityRef.fields.resourceId;
const partyFields = customerFields.party.schema.fields;
const contactFields = partyFields.contactPoints.value.fields;
const partyId = customerFields.partyRef.fields.resourceId;

/** The owner profile with plain ids. `profileKind` says which kind of profile `profileId` names. */
const ProfileSchema = Schema.Struct({
  profileId: Schema.Union([retailProfile.fields.resourceId, counterpartyProfile.fields.resourceId]),
  profileKind: Schema.Union([retailProfile.fields.kind, counterpartyProfile.fields.kind]),
  revision: profileFields.revision,
  state: profileFields.state,
  subject: Schema.Union([
    Schema.Struct({ kind: retailSubject.fields.kind, partyId, sellingLegalEntityId }),
    Schema.Struct({
      counterpartyId: counterpartySubject.fields.counterpartyRef.fields.resourceId,
      kind: counterpartySubject.fields.kind,
      sellingLegalEntityId: Schema.optionalKey(sellingLegalEntityId),
    }),
  ]),
});
const PartySchema = Schema.Struct({
  ...Struct.omit(partyFields, ['contactPoints', 'partyRef']),
  contactPoints: Schema.Array(
    Schema.Struct({
      ...Struct.omit(contactFields, ['contactPointRef']),
      contactPointId: contactFields.contactPointRef.fields.resourceId,
    }),
  ).check(Schema.isMaxLength(256)),
  partyId,
});

/**
 * The public body of `GET /admin/customers`: camelCase, no internal markers and no nullable field of its own.
 * Every reference is a plain id. The nested `party`, `businessName` and `ico` otherwise keep their owner shapes;
 * an unselected or unreadable part is absent.
 */
export const SymmyCustomersResponseSchema = Schema.Struct({
  count: projectionFields.count,
  customers: Schema.Array(
    Schema.Struct({
      ...Struct.pick(customerFields, ['ico', 'id']),
      businessName: customerFields.business_name,
      party: Schema.optionalKey(PartySchema),
      partyId,
      profile: ProfileSchema,
      sourceRecordId: customerFields.source_record_id,
    }),
  ),
  limit: projectionFields.limit,
  offset: projectionFields.offset,
});
type SymmyCustomersResponse = typeof SymmyCustomersResponseSchema.Type;

type Customer = SymmyInternalCustomersProjection['customers'][number];

const mapSubject = (subject: Customer['profile']['subject']) => {
  if (subject.kind === 'RETAIL') {
    return {
      kind: subject.kind,
      partyId: subject.partyRef.resourceId,
      sellingLegalEntityId: subject.sellingLegalEntityRef.resourceId,
    };
  }
  const base = { counterpartyId: subject.counterpartyRef.resourceId, kind: subject.kind };
  return subject.sellingLegalEntityRef === undefined
    ? base
    : { ...base, sellingLegalEntityId: subject.sellingLegalEntityRef.resourceId };
};

const mapProfile = ({ profileRef, revision, state, subject }: Customer['profile']) => ({
  profileId: profileRef.resourceId,
  profileKind: profileRef.kind,
  revision,
  state,
  subject: mapSubject(subject),
});

const mapParty = ({ contactPoints, partyRef, ...party }: NonNullable<Customer['party']>) => ({
  ...party,
  contactPoints: contactPoints.map(({ contactPointRef, ...contact }) => ({
    ...contact,
    contactPointId: contactPointRef.resourceId,
  })),
  partyId: partyRef.resourceId,
});

const mapCustomer = (customer: Customer) => {
  const {
    business_name: businessName,
    party,
    partyRef,
    profile,
    source_record_id: sourceRecordId,
    ...shared
  } = customer;
  const base = { ...shared, partyId: partyRef.resourceId, profile: mapProfile(profile), sourceRecordId };
  const named = businessName === undefined ? base : { ...base, businessName };
  return party === undefined ? named : { ...named, party: mapParty(party) };
};

/** `unsupported_fields` is still computed by the projection and is deliberately not exposed. */
export const mapSymmyCustomersProjection = (projection: SymmyInternalCustomersProjection): SymmyCustomersResponse => ({
  count: projection.count,
  customers: projection.customers.map(mapCustomer),
  limit: projection.limit,
  offset: projection.offset,
});
