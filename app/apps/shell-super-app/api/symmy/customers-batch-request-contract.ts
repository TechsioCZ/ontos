import { AddSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/add-saved-address-action';
import { AddContactPointPayloadSchema, CreatePartyPayloadSchema } from '@app/party-registry/api';
import { OfficialIdentifierInputSchema } from '@app/party-registry/domain/identifier-contracts';
import { SymmyCustomerPlanSizeSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Result, Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
/** The names and the label are the owners' own, so what Party or Commerce cannot store is refused here with 400. */
const candidate = CreatePartyPayloadSchema.fields.candidate.fields;
const personName = candidate.firstName.schema;
const addressLabel = AddSavedAddressPayloadSchema.fields.label.schema;
const SymmyCustomerIdSchema = boundedText.pipe(Schema.brand('SymmyCustomerId'));

/** ICO and CZ_DIC are checked by the Party Registry owner schema itself, so the rules cannot drift. */
const SymmyOfficialIdentifierSchema = Schema.Struct({
  type: Schema.Literals(['ICO', 'CZ_DIC']),
  value: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(({ type, value }) =>
    Result.isSuccess(Schema.decodeUnknownResult(OfficialIdentifierInputSchema)({ identifierType: type, value }))
      ? undefined
      : `invalid ${type} value`,
  ),
);

/** Email and phone are the Party owner's own contact point inputs, so the rules cannot drift. */
const [EmailContactSchema, PhoneContactSchema] = AddContactPointPayloadSchema.fields.contactPoint.members;
/** The postal address is the Commerce owner's own Commerce-only address. */
const [PostalAddressSchema] = AddSavedAddressPayloadSchema.fields.origin.members[1].fields.postalAddress.schema.members;
/** A Commerce-only saved address. Name, company and phone per address do not exist. */
const SymmyAddressSchema = Schema.Struct({
  label: Schema.optionalKey(addressLabel),
  postalAddress: PostalAddressSchema,
  purposes: Schema.Array(Schema.Literals(['BILLING', 'DELIVERY'])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
    Schema.makeFilter((purposes) =>
      new Set(purposes).size === purposes.length ? undefined : 'Address purposes must be unique',
    ),
  ),
});

const shared = {
  addresses: Schema.optionalKey(Schema.Array(SymmyAddressSchema).check(Schema.isMaxLength(10))),
  contacts: Schema.optionalKey(
    Schema.Array(Schema.Union([EmailContactSchema, PhoneContactSchema])).check(Schema.isMaxLength(10)),
  ),
  customerId: SymmyCustomerIdSchema,
  officialIdentifiers: Schema.optionalKey(Schema.Array(SymmyOfficialIdentifierSchema).check(Schema.isMaxLength(20))),
} as const;

/** `kind` decides the owner flow and which name fields exist: the other kind's name fields are unknown. */
const SymmyCustomerSchema = Schema.Union([
  Schema.Struct({
    ...shared,
    firstName: personName,
    kind: Schema.Literal('PERSON'),
    lastName: candidate.lastName.schema,
  }),
  Schema.Struct({ ...shared, businessName: candidate.businessName.schema, kind: Schema.Literal('ORGANIZATION') }),
]);

/** The public body of `POST /customers/batch`: one to sixteen customers. */
export const SymmyCustomersBatchRequestSchema = Schema.Struct({
  customers: Schema.NonEmptyArray(SymmyCustomerSchema).check(
    Schema.isMaxLength(16),
    Schema.makeFilter(
      (customers) => Schema.is(SymmyCustomerPlanSizeSchema)(customers) || 'A request needs more than one plan holds',
    ),
  ),
});
export type SymmyCustomersBatchRequest = typeof SymmyCustomersBatchRequestSchema.Type;
