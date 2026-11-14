import { OfficialIdentifierInputSchema } from '@app/party-registry/domain/identifier-contracts';
import { Result, Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const SymmyCustomerIdSchema = boundedText.pipe(Schema.brand('SymmyCustomerId'));
const countryCode = Schema.Trim.check(Schema.isMinLength(2), Schema.isMaxLength(2), Schema.isPattern(/^[A-Za-z]{2}$/u));

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

const EmailContactSchema = Schema.Struct({
  preferred: Schema.Boolean,
  type: Schema.Literal('EMAIL'),
  value: Schema.Trim.check(
    Schema.isMinLength(3),
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  ),
});
const phoneValue = Schema.Trim.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(100),
  Schema.isPattern(/^\+?[()0-9 .-]+$/u),
);
const phoneShared = {
  extension: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(12), Schema.isPattern(/^[0-9]+$/u)),
  ),
  preferred: Schema.Boolean,
  type: Schema.Literal('PHONE'),
} as const;
/** A leading `+` carries its own country; any other number needs `countryCode`. */
const PhoneContactSchema = Schema.Union([
  Schema.Struct({
    ...phoneShared,
    countryCode: Schema.optionalKey(countryCode),
    value: phoneValue.check(Schema.isPattern(/^\+[() .-]*[1-9]/u)),
  }),
  Schema.Struct({
    ...phoneShared,
    countryCode,
    value: phoneValue.check(Schema.isPattern(/^[0-9(]/u)),
  }),
]);

const PostalAddressSchema = Schema.Struct({
  addressLine1: boundedText,
  addressLine2: Schema.optionalKey(boundedText),
  city: boundedText,
  countryCode: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u)),
  postalCode: boundedText,
  region: Schema.optionalKey(boundedText),
});
/** A Commerce-only saved address. Name, company and phone per address do not exist. */
const SymmyAddressSchema = Schema.Struct({
  label: Schema.optionalKey(boundedText),
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
  Schema.Struct({ ...shared, firstName: boundedText, kind: Schema.Literal('PERSON'), lastName: boundedText }),
  Schema.Struct({ ...shared, businessName: boundedText, kind: Schema.Literal('ORGANIZATION') }),
]);

/** The public body of `POST /customers/batch`: one to sixteen customers. */
export const SymmyCustomersBatchRequestSchema = Schema.Struct({
  customers: Schema.NonEmptyArray(SymmyCustomerSchema).check(Schema.isMaxLength(16)),
});
export type SymmyCustomersBatchRequest = typeof SymmyCustomersBatchRequestSchema.Type;
