import { Schema } from "effect";

const PostalAddressSchema = Schema.Struct({
  addressLine1: Schema.String,
  addressLine2: Schema.optional(Schema.String),
  city: Schema.String,
  countryCode: Schema.String,
  postalCode: Schema.String,
  region: Schema.optional(Schema.String),
});

export const CustomerAddressSchema = Schema.Struct({
  id: Schema.String,
  isBillingDefault: Schema.Boolean,
  isDeliveryDefault: Schema.Boolean,
  label: Schema.optional(Schema.String),
  location: Schema.Union([
    Schema.Struct({ address: PostalAddressSchema, state: Schema.Literal("available") }),
    Schema.Struct({ state: Schema.Literal("unresolved") }),
  ]),
  purposes: Schema.Array(Schema.Literals(["BILLING", "DELIVERY"])),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type CustomerAddress = typeof CustomerAddressSchema.Type;
export const CustomerAddressesReadSchema = Schema.Union([
  Schema.Struct({
    addresses: Schema.Array(CustomerAddressSchema),
    state: Schema.Literal("ready"),
    viewerEmail: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("anonymous") }),
]);
export type CustomerAddressesRead = typeof CustomerAddressesReadSchema.Type;

const addressTarget = {
  addressId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  revision: CustomerAddressSchema.fields.revision,
};
const postalField = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const addressFields = {
  postalAddress: Schema.Struct({
    addressLine1: postalField,
    addressLine2: Schema.optionalKey(postalField),
    city: postalField,
    countryCode: Schema.Trim.check(Schema.isPattern(/^[A-Z]{2}$/u)),
    postalCode: postalField,
    region: Schema.optionalKey(postalField),
  }),
  purposes: Schema.Array(Schema.Literals(["BILLING", "DELIVERY"])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
    Schema.makeFilter((purposes) =>
      new Set(purposes).size === purposes.length ? undefined : "Address purposes must be unique",
    ),
  ),
};
const operationId = { operationId: Schema.String.check(Schema.isUUID()) };
export const CustomerAddressCommandSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("add"), ...operationId, ...addressFields }),
  Schema.Struct({
    operation: Schema.Literal("update"),
    ...operationId,
    ...addressTarget,
    ...addressFields,
  }),
  Schema.Struct({ operation: Schema.Literal("remove"), ...operationId, ...addressTarget }),
]);
export type CustomerAddressCommand = typeof CustomerAddressCommandSchema.Type;
export const CustomerAddressSavedSchema = Schema.Struct({ outcome: Schema.Literal("SAVED") });

export interface CustomerAddressViewer {
  readonly partyId: string;
  readonly tenantId: string;
  readonly viewerEmail: string;
}
