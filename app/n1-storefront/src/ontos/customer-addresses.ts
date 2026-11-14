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

export interface CustomerAddressViewer {
  readonly partyId: string;
  readonly tenantId: string;
  readonly viewerEmail: string;
}
